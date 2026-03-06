import * as crypto from 'crypto';
import { loadConfig, loadMappingConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { MiraklClient } from '../miraklClient';
import { StateManager } from '../state/stateManager';
import { loadTemplates } from '../templates/templateReader';
import { mapProductToRows } from '../mappers/productMapper';
import { mapOfferToRows } from '../mappers/offerMapper';
import { writeCsv, previewCsv } from '../exporters/csvExporter';
import { SyncOptions, SyncResult, MiraklRow, MappingConfig } from '../types';
import { ShopifyProduct } from '../types';
import { logger } from '../logger';

// ─── Main sync orchestrator ───────────────────────────────────────────────────
// Uploads PA01 (products) only. Generates and saves the OF01 CSV for later.
// Use `check-import` to poll PA01 status and trigger OF01 upload.

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const { dryRun, incremental, stockOnly, templatesPath } = options;

  logger.info('═══════════════════════════════════════════════════');
  logger.info(' Shopify → Mirakl Sync');
  logger.info('═══════════════════════════════════════════════════');
  logger.info('Mode', { dryRun, incremental, stockOnly });

  const config  = loadConfig();
  const mapping = loadMappingConfig();

  // ─── Load templates ────────────────────────────────────────────────────────
  const resolvedTemplatesPath =
    templatesPath ?? process.env.TEMPLATES_PATH ?? config.paths.templates;

  logger.info('Loading Mirakl templates...', { path: resolvedTemplatesPath });
  const templates = await loadTemplates(resolvedTemplatesPath);

  const isCombined = templates.combined !== null;
  logger.info('Template mode', { isCombined });

  if (!templates.products && !templates.offers && !templates.combined) {
    throw new Error(`No valid templates in: ${resolvedTemplatesPath}`);
  }

  // ─── State ─────────────────────────────────────────────────────────────────
  const state   = new StateManager(config.paths.state);
  const current = state.read();

  // Block if there's already a pending PA01 import
  if (current.pendingProductImport) {
    logger.error('A product import is already pending — run check-import first', {
      importId: current.pendingProductImport.importId,
      uploadedAt: current.pendingProductImport.uploadedAt,
    });
    throw new Error('Pending product import exists. Run check-import to resolve it before syncing again.');
  }

  state.markRunStarted();

  let since: string | undefined;
  if (incremental && current.lastSuccessfulSync) {
    since = current.lastSuccessfulSync;
    logger.info('Incremental: fetching products updated since', { since });
  } else if (incremental) {
    logger.warn('No previous sync found — running full sync');
  }

  // ─── Fetch from Shopify ────────────────────────────────────────────────────
  const shopify  = new ShopifyClient(config);
  const products = await shopify.fetchAllProducts(since);

  if (products.length === 0) {
    logger.info('No products to sync.');
    state.markSuccess();
    return emptyResult();
  }

  logger.info(`Fetched ${products.length} products with ${products.reduce((n, p) => n + p.variants.length, 0)} total variants`);

  // ─── Resolve headers ───────────────────────────────────────────────────────
  let outputHeaders: string[];
  if (isCombined && templates.combined) {
    outputHeaders = templates.combined.headers;
  } else if (templates.products) {
    outputHeaders = templates.products.headers;
  } else {
    throw new Error('No product template headers available');
  }

  // Split combined headers into product vs offer columns
  const skuIdx = outputHeaders.findIndex((h) => h.toLowerCase() === 'sku');
  const productHeaders = skuIdx > 0 ? outputHeaders.slice(0, skuIdx) : outputHeaders;
  const offerHeaders   = skuIdx > 0 ? outputHeaders.slice(skuIdx) : (templates.offers?.headers ?? []);

  logger.info('Column split', {
    productCols: productHeaders.length,
    offerCols: offerHeaders.length,
  });

  // ─── Map products and compute hashes for incremental ───────────────────────
  const result: SyncResult = {
    totalProducts:    products.length,
    totalVariants:    products.reduce((n, p) => n + p.variants.length, 0),
    productsExported: 0,
    offersExported:   0,
    skipped:          0,
    failed:           0,
    errors:           [],
  };

  const allProductRows: MiraklRow[] = [];
  const allOfferRows:   MiraklRow[] = [];
  const newHashes: Record<string, string> = {};
  const oldHashes = current.productHashes ?? {};
  let unchangedCount = 0;

  logger.info(`Mapping ${products.length} products...`);
  for (let i = 0; i < products.length; i++) {
    const product = products[i]!;
    try {
      const pRows = mapProductToRows(product, productHeaders, mapping);
      const oRows = offerHeaders.length > 0
        ? mapOfferToRows(product, offerHeaders, mapping, stockOnly)
        : [];

      if (pRows.length === 0) {
        result.skipped++;
        continue;
      }

      // Hash the product rows to detect changes
      const hash = hashRows(pRows);
      newHashes[product.numericId] = hash;

      if (oldHashes[product.numericId] === hash) {
        unchangedCount++;
        // Still include offer rows (price/stock can change independently)
        allOfferRows.push(...oRows);
        result.offersExported += oRows.length;
        continue;
      }

      allProductRows.push(...pRows);
      allOfferRows.push(...oRows);
      result.productsExported += pRows.length;
      result.offersExported   += oRows.length;
    } catch (err) {
      result.failed++;
      const reason = err instanceof Error ? err.message : String(err);
      result.errors.push({ identifier: product.title, reason });
      logger.error('Failed to map product', { title: product.title, error: reason });
    }
    if ((i + 1) % 200 === 0) {
      logger.info(`  Mapped ${i + 1}/${products.length}...`);
    }
  }

  logger.info(`Mapping complete`, {
    productRows: allProductRows.length,
    offerRows: allOfferRows.length,
    unchanged: unchangedCount,
    changed: products.length - unchangedCount - result.skipped - result.failed,
  });

  // ─── Dry run ───────────────────────────────────────────────────────────────
  if (dryRun) {
    previewCsv(productHeaders, allProductRows, 'Products (PA01)');
    if (offerHeaders.length > 0) previewCsv(offerHeaders, allOfferRows, 'Offers (OF01)');
    printSummary(result, true);
    return result;
  }

  // ─── Write offer CSV to disk (for later OF01 upload) ───────────────────────
  let offersCsvPath: string | null = null;
  if (offerHeaders.length > 0 && allOfferRows.length > 0) {
    offersCsvPath = writeCsv(offerHeaders, allOfferRows, {
      outputDir: config.paths.output,
      filename:  stockOnly ? 'offers-stock' : 'offers',
    });
    logger.info('Offers CSV saved for later upload', { path: offersCsvPath, rows: allOfferRows.length });
  }

  // ─── Upload PA01 (products) ────────────────────────────────────────────────
  if (allProductRows.length === 0 && !stockOnly) {
    logger.info('All products unchanged — skipping PA01 upload');
    // Still need to handle offers if stock-only or if products already exist
    if (offersCsvPath) {
      logger.info('Uploading offers directly (no product changes)...');
      const mirakl = new MiraklClient(config);
      const offerImportId = await mirakl.uploadOffersFile(offersCsvPath);
      result.miraklImportId = offerImportId;
      logger.info('Offers upload accepted', { importId: offerImportId });
    }
    // Save updated hashes
    state.write({ ...state.read(), productHashes: { ...oldHashes, ...newHashes } });
    state.markSuccess();
    printSummary(result, false);
    return result;
  }

  const productCsvPath = writeCsv(productHeaders, allProductRows, {
    outputDir: config.paths.output,
    filename:  'products',
  });

  const mirakl = new MiraklClient(config);
  logger.info('Uploading products to Mirakl PA01...');
  const productImportId = await mirakl.uploadProductsFile(productCsvPath);

  // Save state: pending import + offers CSV path + updated hashes
  state.write({
    ...state.read(),
    pendingProductImport: {
      importId: productImportId,
      offersCsvPath: offersCsvPath ?? '',
      uploadedAt: new Date().toISOString(),
    },
    productHashes: { ...oldHashes, ...newHashes },
  });

  logger.info('PA01 upload accepted. Run check-import to monitor and trigger OF01.', {
    importId: productImportId,
  });

  printSummary(result, false);
  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashRows(rows: MiraklRow[]): string {
  const content = rows.map((r) => JSON.stringify(r)).join('|');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function emptyResult(): SyncResult {
  return { totalProducts: 0, totalVariants: 0, productsExported: 0, offersExported: 0, skipped: 0, failed: 0, errors: [] };
}

function printSummary(result: SyncResult, dryRun: boolean): void {
  const mode = dryRun ? '[DRY RUN] ' : '';
  logger.info('');
  logger.info('═══════════════════════════════════════════════════');
  logger.info(` ${mode}Sync Summary`);
  logger.info('═══════════════════════════════════════════════════');
  logger.info(`  Products fetched  : ${result.totalProducts}`);
  logger.info(`  Variants fetched  : ${result.totalVariants}`);
  logger.info(`  Product rows (PA01): ${result.productsExported}`);
  logger.info(`  Offer rows (OF01)  : ${result.offersExported}`);
  logger.info(`  Skipped (no SKU)  : ${result.skipped}`);
  logger.info(`  Failed            : ${result.failed}`);
  if (result.miraklImportId) {
    logger.info(`  Mirakl import ID  : ${result.miraklImportId}`);
  }
  if (result.errors.length > 0) {
    logger.info('  Errors:');
    for (const e of result.errors.slice(0, 10)) logger.info(`    - ${e.identifier}: ${e.reason}`);
    if (result.errors.length > 10) logger.info(`    ... and ${result.errors.length - 10} more`);
  }
  logger.info('═══════════════════════════════════════════════════');
}
