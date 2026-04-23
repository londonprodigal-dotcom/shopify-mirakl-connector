import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { ShopifyClient } from '../../shopifyClient';
import { query } from '../../db/pool';
import { enqueueJob } from '../../queue/enqueue';
import { logger } from '../../logger';

/**
 * Hourly sweep: for each SKU in pending_catalog that has seen a Shopify
 * inventory webhook since its last poll (or has never been polled), check
 * whether Mirakl now has an active offer for it. If yes, re-enqueue a
 * stock_update with the current Shopify qty — this is the PA01-race
 * resolution path. If no, update last_poll_at and leave the row unresolved.
 *
 * Design choices (see Release B plan):
 *  - Scoping: webhook-touched only. An abandoned SKU that never sees another
 *    inventory change doesn't matter — Shopify won't re-fire, so there's
 *    nothing to re-enqueue anyway. Pruning naturally.
 *  - Fetch: OF52 (bulk async export, rate-limit-free, ~10s for the full
 *    offer set) instead of per-SKU OF21 (rate-limited). At any plausible
 *    pending_catalog size this is strictly cheaper.
 *  - Shopify qty lookup: reuse the same fetchAllInventoryAndPrices path that
 *    stock_reconcile uses. Only runs when there's at least one resurrected
 *    SKU, so cost is bounded.
 */
export async function handleResurrectionPoll(_payload: Record<string, unknown>): Promise<void> {
  // 1. Find webhook-touched pending SKUs
  const touched = await query<{ sku: string }>(
    `SELECT sku FROM pending_catalog
      WHERE resolved_at IS NULL
        AND (last_poll_at IS NULL OR last_seen_at > last_poll_at)
      ORDER BY last_seen_at DESC`
  );
  if (touched.rows.length === 0) {
    logger.info('[resurrection_poll] No webhook-touched pending SKUs — skipping');
    return;
  }
  const touchedSkus = new Set(touched.rows.map(r => r.sku));
  logger.info('[resurrection_poll] Webhook-touched pending SKUs', { count: touchedSkus.size });

  const config = loadConfig();
  const mirakl = new MiraklClient(config);

  // 2. Bulk Mirakl offer state via OF52 (rate-limit-free, ~10s)
  let miraklOffers: Array<{ sku: string; quantity: number; price: number }>;
  try {
    miraklOffers = await mirakl.fetchAllOffers();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[resurrection_poll] OF52 fetch failed — will retry next cycle', { error: msg });
    return;
  }
  const activeMiraklSkus = new Set<string>();
  for (const offer of miraklOffers) {
    if (offer.sku) activeMiraklSkus.add(offer.sku);
  }

  // 3. Partition touched SKUs: those now live on Mirakl vs still orphan
  const resurrected: string[] = [];
  const stillOrphan: string[] = [];
  for (const sku of touchedSkus) {
    if (activeMiraklSkus.has(sku)) resurrected.push(sku);
    else stillOrphan.push(sku);
  }

  // 4. For resurrected SKUs, re-enqueue stock_update with CURRENT Shopify qty.
  // We use the current qty (not last_qty from pending_catalog) because Shopify
  // inventory has likely moved since the SKU first went orphan.
  if (resurrected.length > 0) {
    const shopify = new ShopifyClient(config);
    const shopifyData = await shopify.fetchAllInventoryAndPrices();
    for (const sku of resurrected) {
      const entry = shopifyData.get(sku);
      if (!entry) {
        logger.warn('[resurrection_poll] Resurrected SKU not found in Shopify — marking resolved, not re-enqueueing', { sku });
        await query(
          `UPDATE pending_catalog SET resolved_at = NOW(), last_poll_at = NOW() WHERE sku = $1`,
          [sku]
        );
        continue;
      }
      await enqueueJob('stock_update', { sku, quantity: entry.quantity }, {});
      await query(
        `UPDATE pending_catalog SET resolved_at = NOW(), last_poll_at = NOW() WHERE sku = $1`,
        [sku]
      );
      logger.info('[resurrection_poll] Resurrected SKU re-enqueued', { sku, qty: entry.quantity });
    }
  }

  // 5. Mark still-orphan touched SKUs as polled (but leave resolved_at NULL).
  // This means they won't be re-swept until another webhook fires for them.
  if (stillOrphan.length > 0) {
    await query(
      `UPDATE pending_catalog SET last_poll_at = NOW() WHERE sku = ANY($1) AND resolved_at IS NULL`,
      [stillOrphan]
    );
  }

  // 6. Summary log + record in sync_state for audit trail
  const summary = {
    at: new Date().toISOString(),
    touchedPending: touchedSkus.size,
    resurrected: resurrected.length,
    stillOrphan: stillOrphan.length,
    miraklOffersTotal: miraklOffers.length,
  };
  await query(
    `INSERT INTO sync_state (key, value) VALUES ('last_resurrection_poll', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(summary)]
  );
  logger.info('[resurrection_poll] Complete', summary);
}
