import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { ShopifyClient } from '../../shopifyClient';
import { query } from '../../db/pool';
import { applyStockBuffer } from './stockUpdate';
import { toMiraklSku } from '../../utils/skuRemap';
import { logger } from '../../logger';

/**
 * One-shot recovery: re-push live quantities/prices for offers the reconcile
 * delisted (qty=0) inside a time window. Built for incident 2026-08-20 21:56Z
 * when a bad qualifying-SKU fetch zeroed 1,464 offers.
 *
 * Payload: { since: ISO, until: ISO, dryRun?: boolean }
 *
 * Uses CURRENT Shopify stock/price (not the ledger snapshot) and the same
 * buffer/price rules as stockReconcile, and only touches SKUs that are
 * debenhams-tagged right now.
 */
export async function handleRestoreDelisted(payload: Record<string, unknown>): Promise<void> {
  const since = String(payload.since ?? '');
  const until = String(payload.until ?? '');
  const dryRun = Boolean(payload.dryRun);
  if (!since || !until) throw new Error('restore_delisted requires since/until');

  const config = loadConfig();
  const shopify = new ShopifyClient(config);
  const mirakl = new MiraklClient(config);
  const { stockBuffer, stockHoldbackLastN, delistMinQualifyingSkus } = config.hardening;

  const rows = await query<{ sku: string }>(
    `SELECT sku FROM stock_ledger WHERE mirakl_qty = 0 AND last_pushed_at BETWEEN $1 AND $2`,
    [since, until]
  );
  logger.info('[restore_delisted] Candidate SKUs from ledger', { count: rows.rows.length, since, until, dryRun });
  if (rows.rows.length === 0) return;

  // Sequential on purpose — two parallel Shopify calls on a cold client raced
  // the OAuth mint and one got a 401 (first run, 2026-08-21 11:14Z).
  const shopifyData = await shopify.fetchAllInventoryAndPrices();
  const qualifyingSkus = await shopify.fetchQualifyingSkus();
  if (qualifyingSkus.size < delistMinQualifyingSkus) {
    throw new Error(`[restore_delisted] qualifying set too small (${qualifyingSkus.size}) — refusing to proceed`);
  }

  const corrections: Array<{ sku: string; shopifySku: string; quantity: number; price: number; discountPrice?: number }> = [];
  let notQualifying = 0;
  let notInShopify = 0;
  let zeroAfterBuffer = 0;
  for (const { sku } of rows.rows) {
    if (!qualifyingSkus.has(sku)) { notQualifying++; continue; }
    const s = shopifyData.get(sku);
    if (!s) { notInShopify++; continue; }
    const qty = applyStockBuffer(s.quantity, stockBuffer, stockHoldbackLastN);
    if (qty === 0) { zeroAfterBuffer++; continue; }
    const compare = parseFloat(s.compareAtPrice || '0');
    const current = parseFloat(s.price || '0');
    const basePrice = compare > current ? compare : current;
    const discount = compare > current ? current : 0;
    corrections.push({
      sku: toMiraklSku(sku),
      shopifySku: sku,
      quantity: qty,
      price: basePrice,
      discountPrice: discount > 0 ? discount : undefined,
    });
  }

  const summary: Record<string, unknown> = {
    at: new Date().toISOString(),
    since, until, dryRun,
    candidates: rows.rows.length,
    toRestore: corrections.length,
    notQualifying, notInShopify, zeroAfterBuffer,
    sample: corrections.slice(0, 5),
  };
  logger.info('[restore_delisted] Plan', summary);

  if (!dryRun && corrections.length > 0) {
    const CHUNK = 500;
    const importIds: Array<string | number> = [];
    for (let i = 0; i < corrections.length; i += CHUNK) {
      const chunk = corrections.slice(i, i + CHUNK);
      const importId = await mirakl.pushBatchUpdate(chunk);
      importIds.push(importId);
      for (const c of chunk) {
        await query(
          `UPDATE stock_ledger SET mirakl_qty = $2, last_pushed_at = NOW(), drift_detected = FALSE WHERE sku = $1`,
          [c.shopifySku, c.quantity]
        );
      }
      logger.info('[restore_delisted] Chunk pushed', { importId, count: chunk.length });
    }
    summary.importIds = importIds;
  }

  await query(
    `INSERT INTO sync_state (key, value) VALUES ('last_restore_delisted', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(summary)]
  );
  await query(
    `INSERT INTO alerts (severity, category, message, metadata) VALUES ('info', 'restore_delisted', $1, $2)`,
    [`Restore delisted: ${dryRun ? 'DRY RUN ' : ''}${corrections.length} offers re-pushed`, JSON.stringify(summary)]
  );
}
