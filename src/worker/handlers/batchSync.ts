import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, loadMappingConfig } from '../../config';
import { ShopifyClient } from '../../shopifyClient';
import { MiraklClient } from '../../miraklClient';
import { loadTemplates } from '../../templates/templateReader';
import { mapProductToRows } from '../../mappers/productMapper';
import { mapOfferToRows } from '../../mappers/offerMapper';
import { writeCsv } from '../../exporters/csvExporter';
import { MiraklRow } from '../../types';
import { query } from '../../db/pool';
import { logger } from '../../logger';

/**
 * Full PA01 + OF01 sync running entirely on Railway.
 * Fetches all Shopify products, maps to Mirakl templates, uploads PA01,
 * polls until complete, then uploads OF01.
 *
 * Triggered via: admin endpoint or scheduled job.
 */
export async function handleBatchSync(_payload: Record<string, unknown>): Promise<void> {
  const config = loadConfig();
  const mapping = loadMappingConfig();
  const shopify = new ShopifyClient(config);
  const mirakl = new MiraklClient(config);

  // Use temp dir on Railway (not local PC)
  const tmpDir = path.join(os.tmpdir(), 'mirakl-sync-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  logger.info('[batch_sync] Starting full resync on Railway', { tmpDir });

  try {
    // ─── Load templates ───────────────────────────────────────────────────
    const templatesPath = process.env.TEMPLATES_PATH ?? config.paths.templates;
    const templates = await loadTemplates(templatesPath);
    const isCombined = templates.combined !== null;

    if (!templates.products && !templates.offers && !templates.combined) {
      throw new Error(`No valid templates in: ${templatesPath}`);
    }

    let outputHeaders: string[];
    if (isCombined && templates.combined) {
      outputHeaders = templates.combined.headers;
    } else if (templates.products) {
      outputHeaders = templates.products.headers;
    } else {
      throw new Error('No product template headers available');
    }

    const skuIdx = outputHeaders.findIndex(h => h.toLowerCase() === 'sku');
    const productHeaders = skuIdx > 0 ? outputHeaders.slice(0, skuIdx) : outputHeaders;
    const offerHeaders = skuIdx > 0 ? outputHeaders.slice(skuIdx) : (templates.offers?.headers ?? []);

    // ─── Fetch all Shopify products ───────────────────────────────────────
    const products = await shopify.fetchAllProducts();
    logger.info(`[batch_sync] Fetched ${products.length} products`);

    if (products.length === 0) {
      logger.info('[batch_sync] No products to sync');
      return;
    }

    // ─── Map to Mirakl rows ──────────────────────────────────────────────
    const allProductRows: MiraklRow[] = [];
    const allOfferRows: MiraklRow[] = [];
    let skipped = 0;
    let failed = 0;

    for (const product of products) {
      try {
        const pRows = mapProductToRows(product, productHeaders, mapping, config.imageProxyBaseUrl);
        const oRows = offerHeaders.length > 0 ? mapOfferToRows(product, offerHeaders, mapping, false) : [];

        if (pRows.length === 0) { skipped++; continue; }

        allProductRows.push(...pRows);
        allOfferRows.push(...oRows);
      } catch (err) {
        failed++;
        logger.error('[batch_sync] Failed to map product', {
          title: product.title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('[batch_sync] Mapping complete', {
      productRows: allProductRows.length,
      offerRows: allOfferRows.length,
      skipped,
      failed,
    });

    // ─── Write CSVs to temp dir ──────────────────────────────────────────
    const productCsvPath = writeCsv(productHeaders, allProductRows, {
      outputDir: tmpDir,
      filename: 'products',
      delimiter: ';',
    });

    let offerCsvPath: string | null = null;
    if (offerHeaders.length > 0 && allOfferRows.length > 0) {
      offerCsvPath = writeCsv(offerHeaders, allOfferRows, {
        outputDir: tmpDir,
        filename: 'offers',
        delimiter: ';',
      });
    }

    // ─── Upload PA01 ─────────────────────────────────────────────────────
    logger.info('[batch_sync] Uploading PA01 products...');
    const pa01ImportId = await mirakl.uploadProductsFile(productCsvPath);
    logger.info('[batch_sync] PA01 accepted', { importId: pa01ImportId });

    // Store offers CSV content in Postgres (filesystem is ephemeral on Railway deploys)
    if (offerCsvPath) {
      const offersCsvContent = fs.readFileSync(offerCsvPath, 'utf8');
      await query(
        `INSERT INTO sync_state (key, value) VALUES ('pending_offers_csv', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [offersCsvContent]
      );
      logger.info('[batch_sync] Offers CSV stored in DB for check_import', { bytes: offersCsvContent.length });
    }

    // Save pending import state to DB (for check_import worker to pick up)
    await query(
      `INSERT INTO sync_state (key, value) VALUES ('pending_product_import', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify({
        importId: pa01ImportId,
        offersCsvPath: '__DB__', // Marker: read from pending_offers_csv in sync_state
        uploadedAt: new Date().toISOString(),
      })]
    );

    logger.info('[batch_sync] PA01 import saved to DB — check_import worker will poll and upload OF01 when ready', {
      importId: pa01ImportId,
    });

    // Record sync run
    await query(
      `INSERT INTO sync_state (key, value) VALUES ('last_batch_sync', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify({
        at: new Date().toISOString(),
        products: products.length,
        productRows: allProductRows.length,
        offerRows: allOfferRows.length,
        pa01ImportId,
        skipped,
        failed,
      })]
    );
  } finally {
    // Clean up temp files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}
