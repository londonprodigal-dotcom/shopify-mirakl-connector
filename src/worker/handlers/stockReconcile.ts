import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { ShopifyClient } from '../../shopifyClient';
import { getPool, query } from '../../db/pool';
import { applyStockBuffer } from './stockUpdate';
import { toMiraklSku } from '../../utils/skuRemap';
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
    const driftSamples: Array<{ sku: string; expected: number; actual: number }> = [];
    const priceDriftSamples: Array<{ sku: string; expectedPrice: number; miraklPrice: number }> = [];
    // `sku` is the Mirakl-side offer-sku (post-remap suffix for V2 offers) sent to OF01.
    // `shopifySku` is the Shopify-side key used by `stock_ledger` for the post-push
    // drift-clear UPDATE — without it, remapped SKUs never clear and oscillate
    // between drifted/corrected forever. Delist entries have no Shopify counterpart.
    const batchCorrections: Array<{ sku: string; shopifySku?: string; quantity: number; price?: number; discountPrice?: number }> = [];

    for (const [sku, shopify] of shopifyData) {
      const expectedMiraklQty = applyStockBuffer(shopify.quantity, stockBuffer, stockHoldbackLastN);
      // Look up using remapped SKU if this offer was recreated with a suffix
      const miraklSku = toMiraklSku(sku);
      const miraklOffer = miraklMap.get(miraklSku) ?? miraklMap.get(sku);

      if (!miraklOffer) continue;

      // Compute expected Mirakl prices using same logic as fieldResolver pricefull/pricesale.
      // Mirakl's export `price` column = the EFFECTIVE selling price (lowest of base/discount).
      // OF01 `price` = base price, OF01 `discount-price` = sale price.
      // So the export's `price` = discount-price when on sale, or base price when not.
      const compare = parseFloat(shopify.compareAtPrice || '0');
      const current = parseFloat(shopify.price || '0');
      const expectedBasePrice = (compare > current) ? compare : current;
      const expectedDiscount = (compare > current) ? current : 0;
      // The export `price` column shows the effective selling price (what the customer pays).
      // That's always the Shopify variant.price (current), regardless of compareAtPrice.
      const expectedSellingPrice = current;

      const qtyDrifted = expectedMiraklQty !== miraklOffer.quantity;
      const priceDrifted = Math.abs(expectedSellingPrice - miraklOffer.price) >= 0.01;

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
        if (priceDrifted) {
          priceDriftCount++;
          if (priceDriftSamples.length < 5) priceDriftSamples.push({ sku, expectedPrice: expectedSellingPrice, miraklPrice: miraklOffer.price });
        }
        if (driftSamples.length < 5 && qtyDrifted) driftSamples.push({ sku, expected: expectedMiraklQty, actual: miraklOffer.quantity });

        // Always assert the correct (base, discount) pair from Shopify state.
        // Mirakl OF01 semantics: empty discount-price CLEARS the field. So we
        // must always populate discount-price when the item is on sale, and we
        // must always send the BASE price (compareAtPrice for sale items; the
        // current price for non-sale). The prior fallback `miraklOffer.price`
        // was the export selling price, not the base — on sale items it would
        // push base=selling, wiping the strikethrough. Incident 2026-04-20.
        batchCorrections.push({
          sku: miraklSku,
          shopifySku: sku,
          quantity: expectedMiraklQty,
          price: expectedBasePrice,
          discountPrice: expectedDiscount > 0 ? expectedDiscount : undefined,
        });
      }
    }

    // ─── Delist non-qualifying offers (not debenhams-tagged) ────────────────
    // Fetch SKUs from debenhams-tagged products, zero out any Mirakl offer
    // whose SKU isn't in the qualifying set.
    // Build a set of SKUs already queued for correction to avoid duplicates
    // (Mirakl rejects OF01 rows with duplicate SKUs in the same file).
    const correctedSkus = new Set(batchCorrections.map(c => c.sku));
    let delistCount = 0;
    try {
      const qualifyingSkus = await shopify.fetchQualifyingSkus();

      // ─── Mass-delist guard (incident 2026-08-20 21:56Z) ──────────────────
      // fetchQualifyingSkus returned a near-empty set for one run (Shopify
      // search-backed `tag:debenhams` query, no GraphQL error) and this loop
      // zeroed 1,464 live offers — Debenhams saw a 99% SKU drop. A tag
      // removal that large is never a legitimate hourly change, so refuse to
      // delist when the qualifying set is implausibly small OR when the
      // delist would hit more than a fraction of the live offers.
      const liveOffers = [...miraklMap.values()].filter(o => o.quantity > 0).length;
      const delistCandidates = [...miraklMap.entries()].filter(([s, o]) => o.quantity > 0 && !qualifyingSkus.has(s)).length;
      const { delistMinQualifyingSkus, delistMaxFraction } = config.hardening;
      const tooFewQualifying = qualifyingSkus.size < delistMinQualifyingSkus;
      const tooManyDelists = liveOffers > 0 && delistCandidates > 20 && delistCandidates / liveOffers > delistMaxFraction;
      if (tooFewQualifying || tooManyDelists) {
        const reason = tooFewQualifying
          ? `qualifying SKU set too small (${qualifyingSkus.size} < ${delistMinQualifyingSkus})`
          : `delist would hit ${delistCandidates}/${liveOffers} live offers (> ${Math.round(delistMaxFraction * 100)}%)`;
        logger.error('Mass-delist guard tripped — skipping delist step this run', { reason, qualifying: qualifyingSkus.size, liveOffers, delistCandidates });
        await query(
          `INSERT INTO alerts (severity, category, message, metadata) VALUES ('critical', 'delist_guard', $1, $2)`,
          [`Stock reconcile refused to delist: ${reason}`, JSON.stringify({ qualifying: qualifyingSkus.size, liveOffers, delistCandidates })]
        );
        throw new Error(`delist guard: ${reason}`);
      }

      for (const [sku, miraklOffer] of miraklMap) {
        if (!qualifyingSkus.has(sku) && miraklOffer.quantity > 0) {
          if (correctedSkus.has(sku)) {
            // Already queued from drift correction — override to qty=0 (delist takes priority)
            const existing = batchCorrections.find(c => c.sku === sku);
            if (existing) existing.quantity = 0;
          } else {
            // Include current Mirakl price — Mirakl requires price even for qty=0 updates
            batchCorrections.push({ sku, quantity: 0, price: miraklOffer.price });
          }
          delistCount++;
        }
      }
      if (delistCount > 0) {
        logger.info('Delisting non-qualifying offers', { delistCount });
      }
    } catch (err) {
      // Guard trip or Shopify failure: drift corrections above still go out,
      // but no delist rows are added this run.
      logger.error('Delist step skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Push all corrections in a single OF01 CSV upload (not individual calls)
    let correctionCount = 0;
    let importResult: { linesOk?: number; linesError?: number; importId?: string | number } = {};
    if (batchCorrections.length > 0) {
      try {
        const importId = await mirakl.pushBatchUpdate(batchCorrections);
        correctionCount = batchCorrections.length;
        importResult = { importId };
        logger.info('Batch corrections pushed', { importId, count: correctionCount });

        // Mark all corrected SKUs in ledger. Match on the Shopify-side sku
        // because that's the key under which `stock_ledger` was upserted (line 99).
        // Falling back to c.sku covers delist entries that have no Shopify counterpart.
        for (const c of batchCorrections) {
          await query(
            `UPDATE stock_ledger SET mirakl_qty = $2, last_pushed_at = NOW(), drift_detected = FALSE WHERE sku = $1`,
            [c.shopifySku ?? c.sku, c.quantity]
          );
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('Batch correction failed', { error: errMsg, count: batchCorrections.length });
        importResult = { linesOk: 0, linesError: batchCorrections.length };
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
        delistCount,
        importResult,
        priceDriftSamples,
      })]
    );

    if (driftCount > config.hardening.driftCriticalCount) {
      await query(
        `INSERT INTO alerts (severity, category, message, metadata) VALUES ('critical', 'stock_drift', $1, $2)`,
        [
          `Stock reconciliation found ${driftCount} qty drifts + ${priceDriftCount} price drifts (threshold: ${config.hardening.driftCriticalCount})`,
          JSON.stringify({ driftCount, priceDriftCount, correctionCount, samples: driftSamples, priceSamples: priceDriftSamples }),
        ]
      );
    }

    logger.info('Stock reconciliation complete', { driftCount, priceDriftCount, correctionCount, delistCount, shopifySkus: shopifyData.size, miraklOffers: miraklOffers.length });
  } finally {
    // Always release advisory lock
    await query(`SELECT pg_advisory_unlock($1)`, [STOCK_RECONCILE_LOCK_ID]);
  }
}
