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
    let enqueuedCount = 0;
    const stuckOrders: string[] = [];
    const STUCK_THRESHOLD_MS = 600_000; // 10 minutes — anything younger is still in-flight

    for (const order of miraklOrders) {
      const orderId = order.order_id;

      const existing = await query<{ status: string; created_at: Date }>(
        `SELECT status, created_at FROM order_map WHERE mirakl_order_id = $1`, [orderId]
      );

      if (existing.rows[0]?.status === 'created') continue;

      enqueuedCount++;
      await enqueueJob('create_order', { mirakl_order_id: orderId });

      // Only flag as stuck if we've known about this order for >10 min and it's still not created
      const row = existing.rows[0];
      if (row && (Date.now() - new Date(row.created_at).getTime()) > STUCK_THRESHOLD_MS) {
        stuckOrders.push(orderId);
        logger.warn('Stuck Mirakl order re-enqueued', { miraklOrderId: orderId, status: row.status });
      } else {
        logger.info('New Mirakl order enqueued', { miraklOrderId: orderId });
      }
    }

    await query(
      `INSERT INTO sync_state (key, value) VALUES ('last_order_reconcile', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify({ at: new Date().toISOString(), miraklOrders: miraklOrders.length, enqueuedCount, stuckCount: stuckOrders.length })]
    );

    // Only alert for genuinely stuck orders, not newly discovered ones
    if (stuckOrders.length > 0) {
      await query(
        `INSERT INTO alerts (severity, category, message, metadata) VALUES ('critical', 'missing_orders', $1, $2)`,
        [
          `${stuckOrders.length} Mirakl order(s) stuck >10min without Shopify order: ${stuckOrders.join(', ')}`,
          JSON.stringify({ stuckOrders, totalMiraklOrders: miraklOrders.length }),
        ]
      );
    }

    logger.info('Order reconciliation complete', { miraklOrders: miraklOrders.length, enqueuedCount, stuckCount: stuckOrders.length });
  } finally {
    await query(`SELECT pg_advisory_unlock($1)`, [ORDER_RECONCILE_LOCK_ID]);
  }
}
