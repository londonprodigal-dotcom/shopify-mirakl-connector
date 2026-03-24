import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { query } from '../../db/pool';
import { enqueueJob } from '../../queue/enqueue';
import { logger } from '../../logger';

export async function handleOrderReconcile(_payload: Record<string, unknown>): Promise<void> {
  const config = loadConfig();
  const mirakl = new MiraklClient(config);
  const lookbackHours = config.hardening.reconcileOrderIntervalMs > 3600_000 ? 48 : 24;

  const since = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
  logger.info('Starting order reconciliation', { since, lookbackHours });

  const miraklOrders = await mirakl.fetchRecentOrders(since);
  let missingCount = 0;

  for (const order of miraklOrders) {
    const orderId = order.order_id;

    // Check order_map
    const existing = await query<{ status: string }>(
      `SELECT status FROM order_map WHERE mirakl_order_id = $1`, [orderId]
    );

    if (existing.rows[0]?.status === 'created') continue; // Already synced

    // Missing or failed — enqueue creation job
    missingCount++;
    await enqueueJob('create_order', { mirakl_order_id: orderId });
    logger.warn('Missing Shopify order for Mirakl order, enqueued', { miraklOrderId: orderId });
  }

  // Record reconciliation
  await query(
    `INSERT INTO sync_state (key, value) VALUES ('last_order_reconcile', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify({ at: new Date().toISOString(), miraklOrders: miraklOrders.length, missingCount })]
  );

  if (missingCount > 0) {
    await query(
      `INSERT INTO alerts (severity, category, message, metadata) VALUES ('critical', 'missing_orders', $1, $2)`,
      [
        `Order reconciliation found ${missingCount} missing Shopify orders`,
        JSON.stringify({ missingCount, totalMiraklOrders: miraklOrders.length }),
      ]
    );
  }

  logger.info('Order reconciliation complete', { miraklOrders: miraklOrders.length, missingCount });
}
