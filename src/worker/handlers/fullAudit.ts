import { query } from '../../db/pool';
import { handleStockReconcile } from './stockReconcile';
import { handleOrderReconcile } from './orderReconcile';
import { logger } from '../../logger';

export async function handleFullAudit(_payload: Record<string, unknown>): Promise<void> {
  logger.info('Starting full audit');
  const auditStart = new Date();

  // 1. Run stock reconciliation
  await handleStockReconcile({});

  // 2. Run order reconciliation
  await handleOrderReconcile({});

  // 3. Reap dead jobs
  const deadJobs = await query<{ count: string }>(`SELECT COUNT(*) as count FROM jobs WHERE status = 'dead'`);
  const deadCount = parseInt(deadJobs.rows[0]?.count ?? '0', 10);

  // 4. Check for stale pending orders
  const staleOrders = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM order_map WHERE status = 'pending' AND created_at < NOW() - interval '1 hour'`
  );
  const staleOrderCount = parseInt(staleOrders.rows[0]?.count ?? '0', 10);

  // 5. Check stock drift
  const driftedSkus = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM stock_ledger WHERE drift_detected = TRUE`
  );
  const driftCount = parseInt(driftedSkus.rows[0]?.count ?? '0', 10);

  // Record audit
  const summary = {
    at: auditStart.toISOString(),
    duration_ms: Date.now() - auditStart.getTime(),
    deadJobs: deadCount,
    staleOrders: staleOrderCount,
    driftedSkus: driftCount,
  };

  await query(
    `INSERT INTO sync_state (key, value) VALUES ('last_full_audit', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(summary)]
  );

  // Info-level summary alert
  await query(
    `INSERT INTO alerts (severity, category, message, metadata) VALUES ('info', 'full_audit', $1, $2)`,
    [`Nightly audit: ${deadCount} dead jobs, ${staleOrderCount} stale orders, ${driftCount} drifted SKUs`, JSON.stringify(summary)]
  );

  logger.info('Full audit complete', summary);
}
