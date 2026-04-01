import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { ShopifyClient } from '../../shopifyClient';
import { withTransaction } from '../../db/pool';
import { toShopifySku } from '../../utils/skuRemap';
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

  // Entire flow runs inside a transaction with a row-level lock on order_map.
  // This serializes concurrent create_order jobs for the same Mirakl order,
  // preventing duplicate Shopify orders.
  await withTransaction(async (client) => {
    // Upsert order_map row and lock it. If another job holds the lock, we block here.
    await client.query(
      `INSERT INTO order_map (mirakl_order_id, status) VALUES ($1, 'pending')
       ON CONFLICT (mirakl_order_id) DO UPDATE SET updated_at = NOW()`,
      [miraklOrderId]
    );
    const locked = await client.query<{ status: string; shopify_order_id: number | null }>(
      `SELECT status, shopify_order_id FROM order_map WHERE mirakl_order_id = $1 FOR UPDATE`,
      [miraklOrderId]
    );

    const row = locked.rows[0];
    if (row?.status === 'created' && row.shopify_order_id) {
      logger.info('Order already created (locked check), skipping', { miraklOrderId, shopifyOrderId: row.shopify_order_id });
      return;
    }

    const config = loadConfig();
    const mirakl = new MiraklClient(config);
    const order = await mirakl.getOrder(miraklOrderId);
    const state = order.order_state ?? order.status ?? '';

    if (!ACTIONABLE_STATES.has(state)) {
      logger.info('Mirakl order not actionable, skipping', { miraklOrderId, state });
      await client.query(
        `UPDATE order_map SET status = 'skipped', updated_at = NOW() WHERE mirakl_order_id = $1`,
        [miraklOrderId]
      );
      return;
    }

    const shopify = new ShopifyClient(config);
    const shopifyOrder = await shopify.createOrderFromMirakl(order, toShopifySku);

    await client.query(
      `UPDATE order_map SET shopify_order_id = $2, shopify_order_name = $3, status = 'created', updated_at = NOW()
       WHERE mirakl_order_id = $1`,
      [miraklOrderId, shopifyOrder.id, shopifyOrder.name]
    );

    logger.info('Shopify order created from Mirakl', {
      miraklOrderId,
      shopifyOrderId: shopifyOrder.id,
      shopifyOrderName: shopifyOrder.name,
    });
  });
}
