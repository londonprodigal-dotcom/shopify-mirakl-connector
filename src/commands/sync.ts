import * as path from 'path';
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

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const { dryRun, incremental, stockOnly, templatesPath } = options;

  logger.info('═══════════════════════════════════════════════════');
  logger.info(' Shopify → Mirakl Sync');
  logger.info('═══════════════════════════════════════════════════');
  logger.info('Mode', { dryRun, incremental, stockOnly });

  // ─── 1. Load configuration ──────────────────────────────────────────────────
  const config  = loadConfig();
  const mapping = loadMappingConfig();

  // ─── 2. Load Mirakl templates ───────────────────────────────────────────────
  const resolvedTemplatesPath =
    templatesPath ?? process.env.TEMPLATES_PATH ?? config.paths.templates;

  logger.info('Loading Mirakl templates...', { path: resolvedTemplatesPath });
  const templates = await loadTemplates(resolvedTemplatesPath);

  const isCombined = templates.combined !== null;
  logger.info('Template mode', { isCombined });

  if (!templates.products && !templates.offers && !templates.combined) {
    throw new Error(`No valid templates in: ${resolvedTemplatesPath}`);
  }

  // ─── 3. State management ────────────────────────────────────────────────────
  const state   = new StateManager(config.paths.state);
  const current = state.read();
  state.markRunStarted();

  let since: string | undefined;
  if (incremental && current.lastSuccessfulSync) {
    since = current.lastSuccessfulSync;
    logger.info('Incremental: fetching products updated since', { since });
  } else if (incremental) {
    logger.warn('No previous sync found – running full sync');
  }

  // ─── 4. Fetch from Shopify ──────────────────────────────────────────────────
  const shopify  = new ShopifyClient(config);
  const products = await shopify.fetchAllProducts(since);

  if (products.length === 0) {
    logger.info('No products to sync.');
    state.markSuccess();
    return emptyResult();
  }

  // ─── 5. Map to Mirakl rows ──────────────────────────────────────────────────
  const result: SyncResult = {
    totalProducts:    products.length,
    totalVariants:    products.reduce((n, p) => n + p.variants.length, 0),
    productsExported: 0,
    offersExported:   0,
    skipped:          0,
    failed:           0,
    errors:           [],
  };

  let outputRows: MiraklRow[] = [];
  let outputHeaders: string[] = [];

  if (isCombined && templates.combined) {
    // ── Combined template: one row per variant with ALL 181 columns ───────────
    outputHeaders = templates.combined.headers;
    for (const product of products) {
      try {
        const rows = mapCombinedRows(product, outputHeaders, mapping, stockOnly);
        outputRows.push(...rows);
        result.productsExported += rows.length;
        result.offersExported   += rows.length;
        if (product.variants.every((v) => !v.sku)) result.skipped++;
      } catch (err) {
        result.failed++;
        const reason = err instanceof Error ? err.message : String(err);
        result.errors.push({ identifier: product.title, reason });
        logger.error('Failed to map product', { title: product.title, error: reason });
      }
    }
  } else {
    // ── Separate product + offer templates ────────────────────────────────────
    const productRows: MiraklRow[] = [];
    const offerRows:   MiraklRow[] = [];

    for (const product of products) {
      try {
        if (!stockOnly && templates.products) {
          const pRows = mapProductToRows(product, templates.products.headers, mapping);
          productRows.push(...pRows);
          result.productsExported += pRows.length;
        }
        if (templates.offers) {
          const oRows = mapOfferToRows(product, templates.offers.headers, mapping, stockOnly);
          offerRows.push(...oRows);
          result.offersExported += oRows.length;
        }
        if (product.variants.every((v) => !v.sku)) result.skipped++;
      } catch (err) {
        result.failed++;
        const reason = err instanceof Error ? err.message : String(err);
        result.errors.push({ identifier: product.title, reason });
        logger.error('Failed to map product', { title: product.title, error: reason });
      }
    }

    // Write/upload separately
    await handleSeparateExport(productRows, offerRows, templates, config, mapping, result, dryRun, stockOnly);
    if (!dryRun && result.failed === 0) state.markSuccess();
    printSummary(result, dryRun);
    return result;
  }

  // ─── 6. Export combined CSV ──────────────────────────────────────────────────
  if (outputRows.length === 0) {
    logger.info('No rows to export.');
    state.markSuccess();
    return result;
  }

  let csvPath: string | null = null;
  if (dryRun) {
    previewCsv(outputHeaders, outputRows, 'Combined Products+Offers');
  } else {
    csvPath = writeCsv(outputHeaders, outputRows, {
      outputDir: config.paths.output,
      filename:  stockOnly ? 'import-stock' : 'import',
    });
  }

  // ─── 7. Upload to Mirakl ────────────────────────────────────────────────────
  if (!dryRun && csvPath) {
    logger.info('Uploading combined import to Mirakl...');
    const mirakl  = new MiraklClient(config);
    // Combined Products+Offers imports go to the offers endpoint in Mirakl
    const status  = await mirakl.importAndWait(csvPath, 'offers');
    result.miraklImportId = status.import_id;
    result.miraklStatus   = status.status;
    logger.info('Import finished', {
      status: status.status,
      ok:     status.lines_in_success,
      errors: status.lines_in_error,
    });
  }

  // ─── 8. Update state ────────────────────────────────────────────────────────
  if (!dryRun && result.failed === 0) {
    state.markSuccess();
  } else if (!dryRun) {
    logger.warn('State not updated — fix mapping errors and re-run.');
  }

  printSummary(result, dryRun);
  return result;
}

// ─── Combined mapper ──────────────────────────────────────────────────────────
// Merges product + offer fields into a single row per variant.

function mapCombinedRows(
  product: ShopifyProduct,
  headers: string[],
  mapping: MappingConfig,
  stockOnly: boolean
): MiraklRow[] {
  // Get product rows (fill product columns) and offer rows (fill offer columns)
  const pRows = mapProductToRows(product, headers, mapping);
  const oRows = mapOfferToRows(product, headers, mapping, stockOnly);

  // Both mappers return one row per variant in the same order — merge them
  return pRows.map((pRow, i) => {
    const oRow = oRows[i] ?? {};
    const merged: MiraklRow = { ...pRow };
    // Offer fields override blanks from product mapper
    for (const [key, val] of Object.entries(oRow)) {
      if (val !== null && val !== undefined && val !== '') {
        merged[key] = val;
      }
    }
    return merged;
  });
}

// ─── Separate template export helper ─────────────────────────────────────────

async function handleSeparateExport(
  productRows: MiraklRow[],
  offerRows: MiraklRow[],
  templates: { products: { headers: string[] } | null; offers: { headers: string[] } | null },
  config: ReturnType<typeof loadConfig>,
  _mapping: MappingConfig,
  result: SyncResult,
  dryRun: boolean,
  stockOnly: boolean
): Promise<void> {
  let productsCsvPath: string | null = null;
  let offersCsvPath:   string | null = null;

  if (!stockOnly && templates.products && productRows.length > 0) {
    if (dryRun) previewCsv(templates.products.headers, productRows, 'Products');
    else productsCsvPath = writeCsv(templates.products.headers, productRows, { outputDir: config.paths.output, filename: 'products' });
  }
  if (templates.offers && offerRows.length > 0) {
    if (dryRun) previewCsv(templates.offers.headers, offerRows, stockOnly ? 'Offers (stock-only)' : 'Offers');
    else offersCsvPath = writeCsv(templates.offers.headers, offerRows, { outputDir: config.paths.output, filename: stockOnly ? 'offers-stock' : 'offers' });
  }

  if (!dryRun) {
    const mirakl = new MiraklClient(config);
    if (productsCsvPath) {
      const s = await mirakl.importAndWait(productsCsvPath, 'products');
      result.miraklImportId = s.import_id;
      result.miraklStatus   = s.status;
    }
    if (offersCsvPath) {
      const s = await mirakl.importAndWait(offersCsvPath, 'offers');
      result.miraklImportId = s.import_id;
      result.miraklStatus   = s.status;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyResult(): SyncResult {
  return { totalProducts: 0, totalVariants: 0, productsExported: 0, offersExported: 0, skipped: 0, failed: 0, errors: [] };
}

function printSummary(result: SyncResult, dryRun: boolean): void {
  const mode = dryRun ? '[DRY RUN] ' : '';
  logger.info('');
  logger.info('═══════════════════════════════════════════════════');
  logger.info(` ${mode}Reconciliation Summary`);
  logger.info('═══════════════════════════════════════════════════');
  logger.info(`  Products fetched  : ${result.totalProducts}`);
  logger.info(`  Variants fetched  : ${result.totalVariants}`);
  logger.info(`  Rows exported     : ${result.productsExported}`);
  logger.info(`  Skipped (no SKU)  : ${result.skipped}`);
  logger.info(`  Failed            : ${result.failed}`);
  if (result.miraklImportId) {
    logger.info(`  Mirakl import ID  : ${result.miraklImportId}`);
    logger.info(`  Mirakl status     : ${result.miraklStatus}`);
  }
  if (result.errors.length > 0) {
    logger.info('  Errors:');
    for (const e of result.errors) logger.info(`    - ${e.identifier}: ${e.reason}`);
  }
  logger.info('═══════════════════════════════════════════════════');
}
