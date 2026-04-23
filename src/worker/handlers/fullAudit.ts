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

  // 3b. Count skipped jobs in the last 24h, grouped by the code on the alert
  // raised at skip-time (catalog_orphan, unknown_terminal, etc.). Map shape
  // means adding new terminal codes later doesn't require a schema change.
  const skippedBreakdown = await query<{ code: string; count: string }>(
    `SELECT COALESCE(metadata->>'code', 'unknown') as code, COUNT(*) as count
       FROM alerts
      WHERE severity = 'info'
        AND created_at >= NOW() - interval '24 hours'
        AND metadata->>'jobType' = 'stock_update'
      GROUP BY code`
  );
  const skippedJobs24hByCode: Record<string, number> = {};
  let skippedCount = 0;
  for (const row of skippedBreakdown.rows) {
    const n = parseInt(row.count ?? '0', 10);
    skippedJobs24hByCode[row.code] = n;
    skippedCount += n;
  }

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

  // 7. Catalog-orphan spike canary: compare last hour's catalog_orphan rate to
  // the 7-day hourly median. A Mirakl soft-outage that temporarily marks valid
  // offers as "state unknown" would drive a sudden surge — this catches it.
  // Floor of max(3x median, 3) ensures quiet periods (median=0) don't fire on
  // a single alert (0→1 false positive) but still catch a genuine burst.
  const spike = await query<{ last_hour: string; median_7d: string }>(`
    WITH hourly AS (
      SELECT date_trunc('hour', created_at) AS hr, COUNT(*) AS n
        FROM alerts
       WHERE category = 'catalog_orphan'
         AND severity = 'info'
         AND created_at >= NOW() - INTERVAL '7 days'
         AND created_at <  date_trunc('hour', NOW())
       GROUP BY hr
    )
    SELECT
      (SELECT COUNT(*) FROM alerts
         WHERE category = 'catalog_orphan'
           AND severity = 'info'
           AND created_at >= NOW() - INTERVAL '1 hour')::int AS last_hour,
      COALESCE(
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY n) FROM hourly),
        0
      )::float AS median_7d
  `);
  const lastHour = parseInt(spike.rows[0]?.last_hour ?? '0', 10);
  const median7d = parseFloat(spike.rows[0]?.median_7d ?? '0');
  const spikeThreshold = Math.max(3 * median7d, 3);
  let spikeFired = false;
  if (lastHour > spikeThreshold) {
    spikeFired = true;
    await query(
      `INSERT INTO alerts (severity, category, message, metadata)
       VALUES ('critical', 'catalog_orphan_spike', $1, $2)`,
      [
        `catalog_orphan spike: ${lastHour} in last hour vs 7d median ${median7d}/hr (threshold ${spikeThreshold})`,
        JSON.stringify({ lastHour, median7d, threshold: spikeThreshold }),
      ]
    );
    logger.warn('[full_audit] catalog_orphan spike detected', { lastHour, median7d, threshold: spikeThreshold });
  }

  // 8. Purge pending_catalog rows that have been resolved for > 30d. Keeps the
  // table lean; resolved rows are a forensic artefact, not operational state.
  const purged = await query(
    `DELETE FROM pending_catalog
           WHERE resolved_at IS NOT NULL
             AND resolved_at < NOW() - INTERVAL '30 days'`
  );
  const pendingCatalogPurged = purged.rowCount ?? 0;

  const summary = {
    at: auditStart.toISOString(),
    duration_ms: Date.now() - auditStart.getTime(),
    deadJobs: deadCount,
    skippedJobs24h: skippedCount,
    skippedJobs24hByCode,
    staleOrders: staleOrderCount,
    driftedSkus: driftCount,
    catalogOrphanLastHour: lastHour,
    catalogOrphanMedian7d: median7d,
    catalogOrphanSpikeFired: spikeFired,
    pendingCatalogPurged,
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
    [severity, `Nightly audit: ${deadCount} dead, ${skippedCount} skipped/24h, ${staleOrderCount} stale orders, ${driftCount} drift, ${errors.length} errors`, JSON.stringify(summary)]
  );

  if (errors.length > 0) {
    logger.warn('Full audit completed with errors', summary);
  } else {
    logger.info('Full audit complete', summary);
  }
}
