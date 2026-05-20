import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { query } from '../../db/pool';
import { logger } from '../../logger';
import { TerminalMiraklError } from '../../queue/types';

export function applyStockBuffer(shopifyQty: number, buffer: number, holdbackLastN: number): number {
  if (shopifyQty <= holdbackLastN) return 0;
  return Math.max(0, shopifyQty - buffer);
}

export async function handleStockUpdate(payload: Record<string, unknown>): Promise<void> {
  const sku = String(payload.sku);
  const shopifyQty = Number(payload.quantity);
  const config = loadConfig();
  const miraklQty = applyStockBuffer(shopifyQty, config.hardening.stockBuffer, config.hardening.stockHoldbackLastN);
  const bufferApplied = shopifyQty - miraklQty;

  // Pre-skip known catalog orphans. Webhook tag-filter (cc30620) blocks
  // non-debenhams products at intake, but SS26 / PA01-stuck SKUs ARE
  // debenhams-tagged and still get enqueued. Without this gate every Shopify
  // inventory change on such a SKU burns the 5-attempt retry budget before
  // dead-lettering. Bumping last_seen_at via worker's TerminalMiraklError
  // upsert keeps the hourly resurrection_poll probing for revival.
  const known = await query<{ sku: string }>(
    `SELECT sku FROM pending_catalog
      WHERE sku = $1 AND resolved_at IS NULL AND error_code = 'catalog_orphan'`,
    [sku]
  );
  if (known.rows.length > 0) {
    throw new TerminalMiraklError(
      `Pre-skipped ${sku}: known catalog_orphan, no live Mirakl offer`,
      { code: 'catalog_orphan', sku }
    );
  }

  const mirakl = new MiraklClient(config);

  // Push stock update and verify Mirakl accepted it.
  // pushStockUpdate returns import_id. pollUntilDone waits for COMPLETE/FAILED.
  // If poll times out or import fails, exception propagates → job retries.
  const importId = await mirakl.pushStockUpdate(sku, miraklQty);
  const result = await mirakl.pollUntilDone(importId, 'offers');

  if (result.lines_in_error > 0) {
    const linesOk = result.lines_in_success ?? 0;
    logger.warn('Stock update had Mirakl errors', { sku, importId, linesOk, linesError: result.lines_in_error });
    if (linesOk === 0) {
      // Single-SKU push fully rejected. Classify as terminal: worker marks the
      // job 'skipped' and upserts pending_catalog so resurrection_poll picks
      // the SKU up when Mirakl revives the offer. The dominant cause is
      // "state of the product is unknown" (PA01 never went live); transient
      // rejections self-heal on the next webhook touch.
      throw new TerminalMiraklError(
        `Mirakl rejected stock update for ${sku} (import ${importId})`,
        { code: 'catalog_orphan', sku, importId }
      );
    }
  }

  // Only update ledger after verified push
  await query(
    `INSERT INTO stock_ledger (sku, shopify_qty, mirakl_qty, buffer_applied, last_pushed_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (sku) DO UPDATE SET
       shopify_qty = $2, mirakl_qty = $3, buffer_applied = $4, last_pushed_at = NOW(), drift_detected = FALSE`,
    [sku, shopifyQty, miraklQty, bufferApplied]
  );

  logger.info('Stock update verified', { sku, shopifyQty, miraklQty, bufferApplied, importId });
}
