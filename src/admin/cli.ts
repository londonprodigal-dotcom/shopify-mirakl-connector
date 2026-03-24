import { query } from '../db/pool';
import { enqueueJob } from '../queue/enqueue';

export async function replayJob(jobId: string): Promise<void> {
  const result = await query<{ id: number; job_type: string; payload: Record<string, unknown> }>(
    `SELECT id, job_type, payload FROM jobs WHERE id = $1 AND status IN ('failed', 'dead')`,
    [jobId]
  );
  if (!result.rows[0]) {
    console.log(`Job ${jobId} not found or not in failed/dead state`);
    return;
  }
  const job = result.rows[0];
  await query(
    `UPDATE jobs SET status = 'pending', attempts = 0, locked_by = NULL, locked_at = NULL, run_after = NOW() WHERE id = $1`,
    [job.id]
  );
  console.log(`Replayed job ${job.id} (${job.job_type})`);
}

export async function replayAllDead(): Promise<void> {
  const result = await query(
    `UPDATE jobs SET status = 'pending', attempts = 0, locked_by = NULL, locked_at = NULL, run_after = NOW() WHERE status = 'dead' RETURNING id, job_type`
  );
  console.log(`Replayed ${result.rowCount} dead-letter jobs`);
  for (const row of result.rows) {
    console.log(`  - Job ${(row as any).id} (${(row as any).job_type})`);
  }
}

export async function reconcileStock(): Promise<void> {
  await enqueueJob('stock_reconcile', {});
  console.log('Stock reconciliation job enqueued');
}

export async function reconcileOrders(): Promise<void> {
  await enqueueJob('order_reconcile', {});
  console.log('Order reconciliation job enqueued');
}

export async function queueStatus(): Promise<void> {
  const result = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count FROM jobs GROUP BY status ORDER BY status`
  );
  console.log('Queue status:');
  for (const row of result.rows) {
    console.log(`  ${row.status}: ${row.count}`);
  }

  const oldest = await query<{ age_minutes: string }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))/60 as age_minutes FROM jobs WHERE status = 'pending'`
  );
  if (oldest.rows[0]?.age_minutes) {
    console.log(`  Oldest pending: ${Math.round(parseFloat(oldest.rows[0].age_minutes))} min`);
  }
}

export async function compareStock(): Promise<void> {
  const result = await query<{ sku: string; shopify_qty: number; mirakl_qty: number; drift_detected: boolean }>(
    `SELECT sku, shopify_qty, mirakl_qty, drift_detected FROM stock_ledger WHERE drift_detected = TRUE ORDER BY sku LIMIT 100`
  );
  if (result.rows.length === 0) {
    console.log('No stock drift detected');
    return;
  }
  console.log(`${result.rows.length} SKUs with drift:`);
  console.log('  SKU | Shopify | Mirakl | Delta');
  console.log('  --- | ------- | ------ | -----');
  for (const row of result.rows) {
    const delta = (row.shopify_qty ?? 0) - (row.mirakl_qty ?? 0);
    console.log(`  ${row.sku} | ${row.shopify_qty ?? '?'} | ${row.mirakl_qty ?? '?'} | ${delta > 0 ? '+' : ''}${delta}`);
  }
}

export async function incidentReport(): Promise<void> {
  console.log('=== Incident Report (last 24h) ===\n');

  // Dead jobs
  const dead = await query<{ id: number; job_type: string; last_error: string; created_at: Date }>(
    `SELECT id, job_type, last_error, created_at FROM jobs WHERE status = 'dead' AND created_at > NOW() - interval '24 hours' ORDER BY created_at DESC`
  );
  console.log(`Dead-letter jobs: ${dead.rows.length}`);
  for (const row of dead.rows) {
    console.log(`  [${row.id}] ${row.job_type}: ${row.last_error?.slice(0, 100)}`);
  }

  // Failed jobs (still retrying)
  const failed = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM jobs WHERE status = 'failed' AND created_at > NOW() - interval '24 hours'`
  );
  console.log(`\nFailed (retrying): ${failed.rows[0]?.count ?? 0}`);

  // Alerts
  const alerts = await query<{ severity: string; category: string; message: string; created_at: Date }>(
    `SELECT severity, category, message, created_at FROM alerts WHERE created_at > NOW() - interval '24 hours' ORDER BY created_at DESC LIMIT 20`
  );
  console.log(`\nAlerts: ${alerts.rows.length}`);
  for (const a of alerts.rows) {
    console.log(`  [${a.severity}] ${a.category}: ${a.message.slice(0, 120)}`);
  }

  // Stock drift
  const drift = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM stock_ledger WHERE drift_detected = TRUE`
  );
  console.log(`\nSKUs with stock drift: ${drift.rows[0]?.count ?? 0}`);

  // Missing orders
  const missing = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM order_map WHERE status = 'pending' AND created_at > NOW() - interval '24 hours'`
  );
  console.log(`\nPending order syncs: ${missing.rows[0]?.count ?? 0}`);

  // Last reconciliation times
  const lastStock = await query<{ value: Record<string, unknown> }>(
    `SELECT value FROM sync_state WHERE key = 'last_stock_reconcile'`
  );
  const lastOrder = await query<{ value: Record<string, unknown> }>(
    `SELECT value FROM sync_state WHERE key = 'last_order_reconcile'`
  );
  console.log(`\nLast stock reconcile: ${(lastStock.rows[0]?.value as any)?.at ?? 'never'}`);
  console.log(`Last order reconcile: ${(lastOrder.rows[0]?.value as any)?.at ?? 'never'}`);
}

export async function purgeCompleted(daysOld: number = 7): Promise<void> {
  const result = await query(
    `DELETE FROM jobs WHERE status = 'completed' AND completed_at < NOW() - ($1 || ' days')::interval`,
    [String(daysOld)]
  );
  console.log(`Purged ${result.rowCount} completed jobs older than ${daysOld} days`);
}
