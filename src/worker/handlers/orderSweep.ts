import crypto from 'crypto';
import { loadConfig } from '../../config';
import { ShopifyClient } from '../../shopifyClient';
import { query } from '../../db/pool';
import { enqueueJob } from '../../queue/enqueue';
import { mapCarrier } from '../../webhooks/shopifyFulfilment';
import { logger } from '../../logger';

/**
 * Worker handler for order_sweep jobs — polling safety net for the Shopify
 * refunds/create and fulfillments/* webhooks.
 *
 * Every run reads the refunds and fulfilments of recent Mirakl-originated
 * Shopify orders and enqueues refund_sync / fulfilment_sync for anything the
 * webhooks did not deliver. Uses the same event fingerprints as the webhook
 * handlers, so whichever path sees an event first wins and the other skips.
 *
 * Cutover: on its first run the sweep records `order_sweep_since` = now and
 * only ever acts on refunds/fulfilments created after that moment. Refunds and
 * shipments from the webhook outage (2 Jun – Oct 2026) were handled by hand on
 * Debenhams and must NOT be replayed.
 */

const LOOKBACK_DAYS = 120;   // refunds can arrive weeks after the order
const BATCH_SIZE = 50;

export async function handleOrderSweep(_payload: Record<string, unknown>): Promise<void> {
  const sinceRow = await query<{ value: { since: string } }>(
    `SELECT value FROM sync_state WHERE key = 'order_sweep_since'`
  );
  if (!sinceRow.rows[0]) {
    const since = new Date().toISOString();
    await query(
      `INSERT INTO sync_state (key, value) VALUES ('order_sweep_since', $1) ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify({ since })]
    );
    logger.info('order_sweep: cutover recorded, nothing before this is replayed', { since });
    return;
  }
  const since = new Date(sinceRow.rows[0].value.since);

  const mapped = await query<{ shopify_order_id: string; mirakl_order_id: string }>(
    `SELECT shopify_order_id, mirakl_order_id FROM order_map
      WHERE status = 'created' AND created_at > NOW() - ($1 || ' days')::interval`,
    [String(LOOKBACK_DAYS)]
  );
  const miraklByShopify = new Map(mapped.rows.map(r => [Number(r.shopify_order_id), r.mirakl_order_id]));
  const ids = [...miraklByShopify.keys()];

  const shopify = new ShopifyClient(loadConfig());
  let refundsQueued = 0;
  let fulfilmentsQueued = 0;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const orders = await shopify.fetchOrdersRefundsAndFulfilments(ids.slice(i, i + BATCH_SIZE));

    for (const order of orders) {
      const miraklOrderId = miraklByShopify.get(order.orderId);
      if (!miraklOrderId) continue;

      for (const refund of order.refunds) {
        if (new Date(refund.createdAt) <= since || refund.lines.length === 0) continue;
        const fingerprint = crypto.createHash('sha256').update(`refund|${refund.id}`).digest('hex');
        const eventId = await insertEvent(fingerprint, 'shopify_refund', { ...refund, order_id: order.orderId, via: 'sweep' });
        if (eventId === null) continue;

        await enqueueJob('refund_sync', {
          mirakl_order_id: miraklOrderId,
          shopify_order_id: order.orderId,
          refund_id: refund.id,
          refund_lines: refund.lines.map(l => ({
            sku: l.sku,
            quantity: l.quantity,
            shopify_line_item_id: l.lineItemId,
            amount: l.subtotal,
            currency: l.currency,
          })),
          note: refund.note,
        }, { eventId });
        refundsQueued++;
        logger.info('order_sweep: refund missed by webhook, enqueued', { miraklOrderId, refundId: refund.id });
      }

      for (const f of order.fulfillments) {
        if (f.status !== 'SUCCESS' || new Date(f.createdAt) <= since) continue;
        // Same fingerprint as the webhook handler, which uses the REST status 'success'.
        const fingerprint = crypto.createHash('sha256').update(`fulfilment|${f.id}|success`).digest('hex');
        const eventId = await insertEvent(fingerprint, 'shopify_fulfilment', { ...f, order_id: order.orderId, via: 'sweep' });
        if (eventId === null) continue;

        const carrier = mapCarrier(f.trackingCompany);
        await enqueueJob('fulfilment_sync', {
          mirakl_order_id: miraklOrderId,
          shopify_order_id: order.orderId,
          fulfilment_id: f.id,
          tracking_number: f.trackingNumber ?? '',
          tracking_url: f.trackingUrl || carrier.carrierUrl,
          carrier_code: carrier.carrierCode,
          carrier_name: carrier.carrierName,
          carrier_url: carrier.carrierUrl,
        }, { eventId });
        fulfilmentsQueued++;
        logger.info('order_sweep: fulfilment missed by webhook, enqueued', { miraklOrderId, fulfilmentId: f.id });
      }
    }
  }

  await query(
    `INSERT INTO sync_state (key, value) VALUES ('last_order_sweep', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify({ at: new Date().toISOString(), orders: ids.length, refundsQueued, fulfilmentsQueued })]
  );
  logger.info('order_sweep: done', { orders: ids.length, refundsQueued, fulfilmentsQueued });
}

async function insertEvent(fingerprint: string, source: string, payload: unknown): Promise<number | null> {
  const res = await query<{ id: number }>(
    `INSERT INTO events (fingerprint, source, payload) VALUES ($1, $2, $3)
     ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
    [fingerprint, source, JSON.stringify(payload)]
  );
  return res.rows[0]?.id ?? null;
}
