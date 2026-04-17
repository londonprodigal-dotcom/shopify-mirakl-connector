import { query } from '../../db/pool';
import { handleStockReconcile } from './stockReconcile';
import { handleOrderReconcile } from './orderReconcile';
import { logger } from '../../logger';

export async function handleFullAudit(_payload: Record<string, unknown>): Promise<void> {
  logger.info('Starting full audit');
  const auditStart = new Date();
  const errors: string[] = [];

  // 1. Run stock reconciliation — isolated, don't let failure block order reconciliation
  try {
    await handleStockReconcile({});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Stock reconciliation failed during audit', { error: msg });
    errors.push(`stock_reconcile: ${msg}`);
  }

  // 2. Run order reconciliation — isolated
  try {
    await handleOrderReconcile({});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Order reconciliation failed during audit', { error: msg });
    errors.push(`order_reconcile: ${msg}`);
  }

  // 3. Reap dead jobs
  const deadJobs = await query<{ count: string }>(`SELECT COUNT(*) as count FROM jobs WHERE status = 'dead'`);
  const deadCount = parseInt(deadJobs.rows[0]?.count ?? '0', 10);

  // 4. Check for stale pending orders
  const staleOrders = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM order_map WHERE status = 'pending' AND created_at < NOW() - interval '1 hour'`
  );
  const staleOrderCount = parseInt(staleOrders.rows[0]?.count ?? '0', 10);

  // 5. Clean up stale drift entries (not verified in >7 days — leftover from old linkage fixes)
  await query(
    `UPDATE stock_ledger SET drift_detected = FALSE WHERE drift_detected = TRUE AND last_verified_at < NOW() - interval '7 days'`
  );

  // 6. Check stock drift (only current entries)
  const driftedSkus = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM stock_ledger WHERE drift_detected = TRUE`
  );
  const driftCount = parseInt(driftedSkus.rows[0]?.count ?? '0', 10);

  const summary = {
    at: auditStart.toISOString(),
    duration_ms: Date.now() - auditStart.getTime(),
    deadJobs: deadCount,
    staleOrders: staleOrderCount,
    driftedSkus: driftCount,
    errors,
  };

  await query(
    `INSERT INTO sync_state (key, value) VALUES ('last_full_audit', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(summary)]
  );

  const severity = errors.length > 0 ? 'warning' : 'info';
  await query(
    `INSERT INTO alerts (severity, category, message, metadata) VALUES ($1, 'full_audit', $2, $3)`,
    [severity, `Nightly audit: ${deadCount} dead, ${staleOrderCount} stale orders, ${driftCount} drift, ${errors.length} errors`, JSON.stringify(summary)]
  );

  if (errors.length > 0) {
    logger.warn('Full audit completed with errors', summary);
  } else {
    logger.info('Full audit complete', summary);
  }
}
