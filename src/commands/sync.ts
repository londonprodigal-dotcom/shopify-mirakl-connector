import { loadConfig, loadMappingConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { MiraklClient } from '../miraklClient';
import { StateManager } from '../state/stateManager';
import { loadTemplates } from '../templates/templateReader';
import { mapProductToRows } from '../mappers/productMapper';
import { mapOfferToRows } from '../mappers/offerMapper';
import { writeCsv, previewCsv } from '../exporters/csvExporter';
import { SyncOptions, SyncResult, ShopifyProduct, MiraklRow } from '../types';
import { logger } from '../logger';

// ─── Main sync orchestrator ───────────────────────────────────────────────────

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const { dryRun, incremental, stockOnly, templatesPath } = options;

  logger.info('═══════════════════════════════════════════════════');
  logger.info(' Shopify → Mirakl Sync');
  logger.info('═══════════════════════════════════════════════════');
  logger.info('Mode', {
    dryRun,
    incremental,
    stockOnly,
    templatesPath: templatesPath ?? '(default)',
  });

  // ─── 1. Load configuration ──────────────────────────────────────────────────
  const config  = loadConfig();
  const mapping = loadMappingConfig();

  // ─── 2. Load Mirakl templates ───────────────────────────────────────────────
  // Resolve templates directory: CLI flag → TEMPLATES_PATH env var → default
  const resolvedTemplatesPath =
    templatesPath ??
    process.env.TEMPLATES_PATH ??
    config.paths.templates;

  logger.info('Loading Mirakl templates...', { path: resolvedTemplatesPath });
  const templates = await loadTemplates(resolvedTemplatesPath);

  const hasProducts = !stockOnly && templates.products !== null;
  const hasOffers   = templates.offers !== null;

  if (stockOnly && !hasOffers) {
    throw new Error(
      `Stock-only mode requires an offers template. ` +
        `Place offers-template.xlsx in: ${resolvedTemplatesPath}`
    );
  }

  if (!hasProducts && !hasOffers) {
    throw new Error(
      `No valid templates loaded. Place at least one template file in: ${resolvedTemplatesPath}`
    );
  }

  logger.info('Templates loaded', {
    products: templates.products ? path.basename(templates.products.filePath) : 'none',
    offers:   templates.offers   ? path.basename(templates.offers.filePath)   : 'none',
  });

  // ─── 3. State management ────────────────────────────────────────────────────
  const state   = new StateManager(config.paths.state);
  const current = state.read();
  state.markRunStarted();

  let since: string | undefined;
  if (incremental && current.lastSuccessfulSync) {
    since = current.lastSuccessfulSync;
    logger.info('Incremental mode – fetching products updated since', { since });
  } else if (incremental) {
    logger.warn(
      'Incremental mode requested but no previous successful sync found – running full sync'
    );
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
    totalProducts:   products.length,
    totalVariants:   products.reduce((n, p) => n + p.variants.length, 0),
    productsExported: 0,
    offersExported:   0,
    skipped:          0,
    failed:           0,
    errors:           [],
  };

  const productRows: MiraklRow[] = [];
  const offerRows:   MiraklRow[] = [];

  for (const product of products) {
    try {
      if (hasProducts && templates.products) {
        const pRows = mapProductToRows(
          product,
          templates.products.headers,
          mapping
        );
        productRows.push(...pRows);
        result.productsExported += pRows.length;
      }

      if (hasOffers && templates.offers) {
        const oRows = mapOfferToRows(
          product,
          templates.offers.headers,
          mapping,
          stockOnly
        );
        offerRows.push(...oRows);
        result.offersExported += oRows.length;
      }

      if (product.variants.every((v) => !v.sku)) {
        result.skipped++;
      }
    } catch (err) {
      result.failed++;
      const reason = err instanceof Error ? err.message : String(err);
      result.errors.push({ identifier: product.title, reason });
      logger.error('Failed to map product', { title: product.title, error: reason });
    }
  }

  // ─── 6. Export CSV files ────────────────────────────────────────────────────
  let productsCsvPath: string | null = null;
  let offersCsvPath:   string | null = null;

  if (hasProducts && templates.products && productRows.length > 0) {
    if (dryRun) {
      previewCsv(templates.products.headers, productRows, 'Products');
    } else {
      productsCsvPath = writeCsv(
        templates.products.headers,
        productRows,
        { outputDir: config.paths.output, filename: 'products' }
      );
    }
  }

  if (hasOffers && templates.offers && offerRows.length > 0) {
    if (dryRun) {
      previewCsv(
        templates.offers.headers,
        offerRows,
        stockOnly ? 'Offers (stock-only)' : 'Offers'
      );
    } else {
      offersCsvPath = writeCsv(
        templates.offers.headers,
        offerRows,
        {
          outputDir: config.paths.output,
          filename: stockOnly ? 'offers-stock' : 'offers',
        }
      );
    }
  }

  // ─── 7. Upload to Mirakl ────────────────────────────────────────────────────
  if (!dryRun) {
    const mirakl = new MiraklClient(config);

    if (productsCsvPath) {
      logger.info('Uploading products to Mirakl...');
      const status = await mirakl.importAndWait(productsCsvPath, 'products');
      result.miraklImportId = status.import_id;
      result.miraklStatus   = status.status;
      logImportResult('Products', status);
    }

    if (offersCsvPath) {
      logger.info('Uploading offers to Mirakl...');
      const status = await mirakl.importAndWait(offersCsvPath, 'offers');
      result.miraklImportId = status.import_id;
      result.miraklStatus   = status.status;
      logImportResult('Offers', status);
    }
  }

  // ─── 8. Update state (full sync only — not for dry runs) ───────────────────
  if (!dryRun && result.failed === 0) {
    state.markSuccess();
  } else if (!dryRun) {
    logger.warn(
      'Not updating last-sync state because some products failed to map. ' +
        'Fix the errors and re-run.'
    );
  }

  // ─── 9. Print reconciliation summary ───────────────────────────────────────
  printSummary(result, dryRun);

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// path is used for basename calls — import it
import * as path from 'path';

function emptyResult(): SyncResult {
  return {
    totalProducts:    0,
    totalVariants:    0,
    productsExported: 0,
    offersExported:   0,
    skipped:          0,
    failed:           0,
    errors:           [],
  };
}

function logImportResult(label: string, status: { status: string; lines_read: number; lines_in_success: number; lines_in_error: number }): void {
  const icon = status.status === 'COMPLETE' && status.lines_in_error === 0 ? '' : '';
  logger.info(`${icon} ${label} import finished`, {
    status:   status.status,
    read:     status.lines_read,
    ok:       status.lines_in_success,
    errors:   status.lines_in_error,
  });
}

function printSummary(result: SyncResult, dryRun: boolean): void {
  const mode = dryRun ? '[DRY RUN] ' : '';
  logger.info('');
  logger.info('═══════════════════════════════════════════════════');
  logger.info(` ${mode}Reconciliation Summary`);
  logger.info('═══════════════════════════════════════════════════');
  logger.info(`  Products fetched from Shopify : ${result.totalProducts}`);
  logger.info(`  Variants fetched              : ${result.totalVariants}`);
  logger.info(`  Product rows exported         : ${result.productsExported}`);
  logger.info(`  Offer rows exported           : ${result.offersExported}`);
  logger.info(`  Skipped (no SKU)              : ${result.skipped}`);
  logger.info(`  Failed to map                 : ${result.failed}`);

  if (result.miraklImportId) {
    logger.info(`  Mirakl import ID              : ${result.miraklImportId}`);
    logger.info(`  Mirakl import status          : ${result.miraklStatus}`);
  }

  if (result.errors.length > 0) {
    logger.info('');
    logger.info('  Errors:');
    for (const e of result.errors) {
      logger.info(`    - ${e.identifier}: ${e.reason}`);
    }
  }

  logger.info('═══════════════════════════════════════════════════');
}
