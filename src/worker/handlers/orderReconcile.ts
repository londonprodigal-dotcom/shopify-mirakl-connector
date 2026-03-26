import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { query } from '../../db/pool';
import { enqueueJob } from '../../queue/enqueue';
import { logger } from '../../logger';

const ORDER_RECONCILE_LOCK_ID = 900002;

export async function handleOrderReconcile(_payload: Record<string, unknown>): Promise<void> {
  const lockResult = await query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock($1) as locked`, [ORDER_RECONCILE_LOCK_ID]
  );
  if (!lockResult.rows[0]?.locked) {
    logger.info('Order reconciliation already running, skipping');
    return;
  }

  try {
    const config = loadConfig();
    const mirakl = new MiraklClient(config);
    const lookbackHours = config.hardening.reconcileOrderIntervalMs > 3600_000 ? 48 : 24;

    const since = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
    logger.info('Starting order reconciliation', { since, lookbackHours });

    let miraklOrders;
    try {
      miraklOrders = await mirakl.fetchRecentOrders(since);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429') || msg.includes('rate')) {
        logger.warn('Order reconciliation skipped — Mirakl rate limited. Will retry next cycle.');
        return;
      }
      throw err;
    }
    let missingCount = 0;

    for (const order of miraklOrders) {
      const orderId = order.order_id;

      const existing = await query<{ status: string }>(
        `SELECT status FROM order_map WHERE mirakl_order_id = $1`, [orderId]
      );

      if (existing.rows[0]?.status === 'created') continue;

      missingCount++;
      await enqueueJob('create_order', { mirakl_order_id: orderId });
      logger.warn('Missing Shopify order for Mirakl order, enqueued', { miraklOrderId: orderId });
    }

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
  } finally {
    await query(`SELECT pg_advisory_unlock($1)`, [ORDER_RECONCILE_LOCK_ID]);
  }
}
