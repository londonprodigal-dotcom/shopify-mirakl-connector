import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { ShopifyClient } from '../../shopifyClient';
import { query } from '../../db/pool';
import { logger } from '../../logger';

const ACTIONABLE_STATES = new Set([
  'WAITING_DEBIT_PAYMENT',
  'WAITING_ACCEPTANCE',
  'SHIPPING',
  'SHIPPED',
  'TO_COLLECT',
  'RECEIVED',
]);

export async function handleCreateOrder(payload: Record<string, unknown>): Promise<void> {
  const miraklOrderId = String(payload.mirakl_order_id);

  // Idempotency check: already created?
  const existing = await query<{ status: string }>(
    `SELECT status FROM order_map WHERE mirakl_order_id = $1`,
    [miraklOrderId]
  );
  if (existing.rows[0]?.status === 'created') {
    logger.info('Order already created, skipping', { miraklOrderId });
    return;
  }

  // Upsert pending entry
  await query(
    `INSERT INTO order_map (mirakl_order_id, status) VALUES ($1, 'pending')
     ON CONFLICT (mirakl_order_id) DO UPDATE SET updated_at = NOW()`,
    [miraklOrderId]
  );

  const config = loadConfig();
  const mirakl = new MiraklClient(config);
  const order = await mirakl.getOrder(miraklOrderId);
  const state = order.order_state ?? order.status ?? '';

  if (!ACTIONABLE_STATES.has(state)) {
    logger.info('Mirakl order not actionable, skipping', { miraklOrderId, state });
    await query(
      `UPDATE order_map SET status = 'skipped', updated_at = NOW() WHERE mirakl_order_id = $1`,
      [miraklOrderId]
    );
    return;
  }

  const shopify = new ShopifyClient(config);
  const shopifyOrder = await shopify.createOrderFromMirakl(order);

  await query(
    `UPDATE order_map SET shopify_order_id = $2, shopify_order_name = $3, status = 'created', updated_at = NOW()
     WHERE mirakl_order_id = $1`,
    [miraklOrderId, shopifyOrder.id, shopifyOrder.name]
  );

  logger.info('Shopify order created from Mirakl', {
    miraklOrderId,
    shopifyOrderId: shopifyOrder.id,
    shopifyOrderName: shopifyOrder.name,
  });
}
