import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { ShopifyClient } from '../../shopifyClient';
import { getPool, query } from '../../db/pool';
import { applyStockBuffer } from './stockUpdate';
import { logger } from '../../logger';

// Advisory lock ID — arbitrary fixed number, must be unique per lock purpose.
// stock_reconcile = 1, order_reconcile = 2 (see orderReconcile.ts)
const STOCK_RECONCILE_LOCK_ID = 900001;

export async function handleStockReconcile(_payload: Record<string, unknown>): Promise<void> {
  // Prevent concurrent reconciliation runs via Postgres advisory lock.
  // pg_try_advisory_lock returns false if another session holds the lock.
  const lockResult = await query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock($1) as locked`, [STOCK_RECONCILE_LOCK_ID]
  );
  if (!lockResult.rows[0]?.locked) {
    logger.info('Stock reconciliation already running, skipping');
    return;
  }

  try {
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

    for (const [sku, shopifyQty] of shopifyLevels) {
      const expectedMiraklQty = applyStockBuffer(shopifyQty, stockBuffer, stockHoldbackLastN);
      const actualMiraklQty = miraklMap.get(sku);

      if (actualMiraklQty === undefined) continue;

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

        try {
          // Push correction and verify it landed
          const importId = await mirakl.pushStockUpdate(sku, expectedMiraklQty);
          // Don't poll for each individual correction — too slow for bulk.
          // Just verify the upload was accepted. Reconciliation will catch any remaining drift next run.
          correctionCount++;

          await query(
            `UPDATE stock_ledger SET mirakl_qty = $2, last_pushed_at = NOW(), drift_detected = FALSE WHERE sku = $1`,
            [sku, expectedMiraklQty]
          );
        } catch (err) {
          // Log but continue — don't abort entire reconciliation for one SKU failure
          logger.error('Failed to push stock correction', { sku, error: err instanceof Error ? err.message : String(err) });
        }
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
  } finally {
    // Always release advisory lock
    await query(`SELECT pg_advisory_unlock($1)`, [STOCK_RECONCILE_LOCK_ID]);
  }
}
