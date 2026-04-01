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
    // Check if corrections are paused via admin endpoint
    const pauseCheck = await query<{ value: unknown }>(
      `SELECT value FROM sync_state WHERE key = 'corrections_paused'`
    );
    const pauseVal = pauseCheck.rows[0]?.value;
    const isPaused = pauseVal && (typeof pauseVal === 'object' ? (pauseVal as any).paused : JSON.parse(String(pauseVal)).paused);
    if (isPaused) {
      logger.info('Stock reconciliation paused via admin — skipping corrections');
      return;
    }

    const config = loadConfig();
    const shopify = new ShopifyClient(config);
    const mirakl = new MiraklClient(config);

    logger.info('Starting stock reconciliation');

    // Fetch from both sides — gracefully skip on rate limit
    let shopifyData: Map<string, { quantity: number; price: string; compareAtPrice: string | null }>;
    let miraklOffers: Array<{ sku: string; quantity: number; price: number }>;
    try {
      [shopifyData, miraklOffers] = await Promise.all([
        shopify.fetchAllInventoryAndPrices(),
        mirakl.fetchAllOffers(),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429') || msg.includes('rate')) {
        logger.warn('Stock reconciliation skipped — Mirakl rate limited. Will retry next cycle.');
        return;
      }
      throw err;
    }

    // Build Mirakl map: sku -> { qty, price }
    const miraklMap = new Map<string, { quantity: number; price: number }>();
    for (const offer of miraklOffers) {
      if (offer.sku) miraklMap.set(offer.sku, { quantity: offer.quantity, price: offer.price });
    }

    const { stockBuffer, stockHoldbackLastN } = config.hardening;
    let driftCount = 0;
    let priceDriftCount = 0;
    let correctionCount = 0;
    const corrections: Array<{ sku: string; expected: number; actual: number }> = [];

    for (const [sku, shopify] of shopifyData) {
      const expectedMiraklQty = applyStockBuffer(shopify.quantity, stockBuffer, stockHoldbackLastN);
      const miraklOffer = miraklMap.get(sku);

      if (!miraklOffer) continue;

      // Compute expected Mirakl price using same logic as fieldResolver pricefull/pricesale
      const compare = parseFloat(shopify.compareAtPrice || '0');
      const current = parseFloat(shopify.price || '0');
      const expectedPrice = (compare > current) ? compare : current;
      const expectedDiscount = (compare > current) ? current : 0;

      const qtyDrifted = expectedMiraklQty !== miraklOffer.quantity;
      const priceDrifted = Math.abs(expectedPrice - miraklOffer.price) >= 0.01;

      const isDrifted = qtyDrifted || priceDrifted;

      // Update stock_ledger
      await query(
        `INSERT INTO stock_ledger (sku, shopify_qty, mirakl_qty, buffer_applied, last_verified_at, drift_detected)
         VALUES ($1, $2, $3, $4, NOW(), $5)
         ON CONFLICT (sku) DO UPDATE SET
           shopify_qty = $2, mirakl_qty = $3, buffer_applied = $4, last_verified_at = NOW(), drift_detected = $5`,
        [sku, shopify.quantity, miraklOffer.quantity, shopify.quantity - expectedMiraklQty, isDrifted]
      );

      if (isDrifted) {
        if (qtyDrifted) driftCount++;
        if (priceDrifted) priceDriftCount++;
        corrections.push({ sku, expected: expectedMiraklQty, actual: miraklOffer.quantity });

        try {
          // Push correction with price when drifted
          await mirakl.pushStockUpdate(
            sku,
            expectedMiraklQty,
            priceDrifted ? expectedPrice : undefined,
            priceDrifted && expectedDiscount > 0 ? expectedDiscount : undefined
          );
          correctionCount++;

          await query(
            `UPDATE stock_ledger SET mirakl_qty = $2, last_pushed_at = NOW(), drift_detected = FALSE WHERE sku = $1`,
            [sku, expectedMiraklQty]
          );
        } catch (err) {
          // Log but continue — don't abort entire reconciliation for one SKU failure
          logger.error('Failed to push stock/price correction', { sku, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // Record reconciliation run
    await query(
      `INSERT INTO sync_state (key, value) VALUES ('last_stock_reconcile', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify({
        at: new Date().toISOString(),
        shopifySkus: shopifyData.size,
        miraklOffers: miraklOffers.length,
        driftCount,
        priceDriftCount,
        correctionCount,
      })]
    );

    if (driftCount > config.hardening.driftCriticalCount) {
      await query(
        `INSERT INTO alerts (severity, category, message, metadata) VALUES ('critical', 'stock_drift', $1, $2)`,
        [
          `Stock reconciliation found ${driftCount} qty drifts + ${priceDriftCount} price drifts (threshold: ${config.hardening.driftCriticalCount})`,
          JSON.stringify({ driftCount, priceDriftCount, correctionCount, samples: corrections.slice(0, 5) }),
        ]
      );
    }

    logger.info('Stock reconciliation complete', { driftCount, priceDriftCount, correctionCount, shopifySkus: shopifyData.size, miraklOffers: miraklOffers.length });
  } finally {
    // Always release advisory lock
    await query(`SELECT pg_advisory_unlock($1)`, [STOCK_RECONCILE_LOCK_ID]);
  }
}
