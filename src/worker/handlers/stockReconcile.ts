import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { ShopifyClient } from '../../shopifyClient';
import { query } from '../../db/pool';
import { applyStockBuffer } from './stockUpdate';
import { logger } from '../../logger';

export async function handleStockReconcile(_payload: Record<string, unknown>): Promise<void> {
  const config = loadConfig();
  const shopify = new ShopifyClient(config);
  const mirakl = new MiraklClient(config);

  logger.info('Starting stock reconciliation');

  // Fetch from both sides
  const [shopifyLevels, miraklOffers] = await Promise.all([
    shopify.fetchAllInventoryLevels(),
    mirakl.fetchAllOffers(),
  ]);

  // Build Mirakl map: sku -> qty
  const miraklMap = new Map<string, number>();
  for (const offer of miraklOffers) {
    if (offer.sku) miraklMap.set(offer.sku, offer.quantity);
  }

  const { stockBuffer, stockHoldbackLastN } = config.hardening;
  let driftCount = 0;
  let correctionCount = 0;
  const corrections: Array<{ sku: string; expected: number; actual: number }> = [];

  // Compare
  for (const [sku, shopifyQty] of shopifyLevels) {
    const expectedMiraklQty = applyStockBuffer(shopifyQty, stockBuffer, stockHoldbackLastN);
    const actualMiraklQty = miraklMap.get(sku);

    if (actualMiraklQty === undefined) continue; // SKU not on Mirakl, skip

    const isDrifted = expectedMiraklQty !== actualMiraklQty;

    // Update stock_ledger
    await query(
      `INSERT INTO stock_ledger (sku, shopify_qty, mirakl_qty, buffer_applied, last_verified_at, drift_detected)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (sku) DO UPDATE SET
         shopify_qty = $2, mirakl_qty = $3, buffer_applied = $4, last_verified_at = NOW(), drift_detected = $5`,
      [sku, shopifyQty, actualMiraklQty, shopifyQty - expectedMiraklQty, isDrifted]
    );

    if (isDrifted) {
      driftCount++;
      corrections.push({ sku, expected: expectedMiraklQty, actual: actualMiraklQty });

      // Push correction
      await mirakl.pushStockUpdate(sku, expectedMiraklQty);
      correctionCount++;

      // Update ledger after push
      await query(
        `UPDATE stock_ledger SET mirakl_qty = $2, last_pushed_at = NOW(), drift_detected = FALSE WHERE sku = $1`,
        [sku, expectedMiraklQty]
      );
    }
  }

  // Record reconciliation run
  await query(
    `INSERT INTO sync_state (key, value) VALUES ('last_stock_reconcile', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify({
      at: new Date().toISOString(),
      shopifySkus: shopifyLevels.size,
      miraklOffers: miraklOffers.length,
      driftCount,
      correctionCount,
    })]
  );

  // Alert if drift is significant
  if (driftCount > config.hardening.driftCriticalCount) {
    await query(
      `INSERT INTO alerts (severity, category, message, metadata) VALUES ('critical', 'stock_drift', $1, $2)`,
      [
        `Stock reconciliation found ${driftCount} drifted SKUs (threshold: ${config.hardening.driftCriticalCount})`,
        JSON.stringify({ driftCount, correctionCount, samples: corrections.slice(0, 5) }),
      ]
    );
  }

  logger.info('Stock reconciliation complete', { driftCount, correctionCount, shopifySkus: shopifyLevels.size, miraklOffers: miraklOffers.length });
}
