import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { query } from '../../db/pool';
import { logger } from '../../logger';

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

  const mirakl = new MiraklClient(config);
  await mirakl.pushStockUpdate(sku, miraklQty);

  await query(
    `INSERT INTO stock_ledger (sku, shopify_qty, mirakl_qty, buffer_applied, last_pushed_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (sku) DO UPDATE SET
       shopify_qty = $2, mirakl_qty = $3, buffer_applied = $4, last_pushed_at = NOW(), drift_detected = FALSE`,
    [sku, shopifyQty, miraklQty, bufferApplied]
  );

  logger.info('Stock update pushed', { sku, shopifyQty, miraklQty, bufferApplied });
}
