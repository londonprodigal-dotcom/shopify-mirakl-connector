import * as os from 'os';
import { loadConfig } from '../config';
import { runMigrations } from '../db/migrate';
import { dequeueJob } from '../queue/dequeue';
import { markCompleted, markFailed } from '../queue/complete';
import { enqueueJob } from '../queue/enqueue';
import { JobType } from '../queue/types';
import { processJob } from './processor';
import { correlationStore } from '../middleware/correlationId';
import { dispatchAlerts } from '../alerts/dispatcher';
import { logger } from '../logger';
import { query } from '../db/pool';

export async function startWorker(): Promise<void> {
  const config = loadConfig();
  const workerId = config.hardening.workerId || os.hostname();

  logger.info('Worker starting', { workerId });
  await runMigrations();

  // Start job poll loop
  pollLoop(workerId, config.hardening.jobPollIntervalMs);

  // Stale job reaper (every 60s)
  setInterval(() => reapStaleJobs(config.hardening.jobStaleTimeoutMs), 60_000);

  // Heartbeat (updates sync_state so health endpoint can check)
  setInterval(() => updateHeartbeat(workerId), 30_000);
  await updateHeartbeat(workerId);

  // Schedule recurring reconciliation jobs
  scheduleRecurring('stock_reconcile', config.hardening.reconcileStockIntervalMs);
  scheduleRecurring('order_reconcile', config.hardening.reconcileOrderIntervalMs);
  scheduleRecurring('check_import', 300_000); // Check for pending PA01 imports every 5min
  scheduleRecurring('catalog_monitor', 1_800_000); // CM11 product status check every 30min
  scheduleNightlyAudit(config.hardening.fullAuditHourUtc);

  // Alert dispatcher (every 30s) — sends to webhook and/or email via Resend
  const alertConfig = {
    webhookUrl: config.hardening.alertWebhookUrl,
    emailTo: config.hardening.alertEmailTo,
    resendApiKey: config.hardening.resendApiKey,
    resendFrom: config.hardening.resendFrom,
  };
  setInterval(() => dispatchAlerts(alertConfig), 30_000);

  // External service watchdogs (every hour)
  const watchdogUrls = config.hardening.watchdogUrls;
  if (watchdogUrls.length > 0) {
    setInterval(() => runWatchdogs(watchdogUrls), 3_600_000);
    // First check after 2 minutes (let services warm up)
    setTimeout(() => runWatchdogs(watchdogUrls), 120_000);
    logger.info(`Watchdogs configured: ${watchdogUrls.length} services`);
  }

  logger.info('Worker ready', { workerId, pollInterval: config.hardening.jobPollIntervalMs });
}

async function pollLoop(workerId: string, intervalMs: number): Promise<void> {
  const config = loadConfig();

  while (true) {
    try {
      if (config.hardening.degradedMode) {
        await sleep(intervalMs * 5); // Slow poll in degraded mode
        continue;
      }

      const job = await dequeueJob(workerId);
      if (!job) {
        await sleep(intervalMs);
        continue;
      }

      // Run handler with correlation context
      await correlationStore.run({ correlationId: job.correlation_id }, async () => {
        logger.info('Processing job', { jobId: job.id, type: job.job_type, attempt: job.attempts });
        try {
          await processJob(job);
          await markCompleted(job.id);
          logger.info('Job completed', { jobId: job.id, type: job.job_type });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          const outcome = await markFailed(job, error);
          if (outcome === 'dead') {
            logger.error('Job dead-lettered', { jobId: job.id, type: job.job_type, error });
            // Insert alert for dead-letter
            await query(
              `INSERT INTO alerts (severity, category, message, metadata) VALUES ('critical', $1, $2, $3)`,
              [job.job_type, `Job ${job.id} exhausted retries: ${error}`, JSON.stringify({ jobId: job.id, jobType: job.job_type, error })]
            );
          } else {
            logger.warn('Job failed, will retry', { jobId: job.id, type: job.job_type, attempt: job.attempts, error });
          }
        }
      });
    } catch (err) {
      logger.error('Poll loop error', { error: err instanceof Error ? err.message : String(err) });
      await sleep(5000); // Back off on unexpected errors
    }
  }
}

async function reapStaleJobs(staleTimeoutMs: number): Promise<void> {
  const result = await query(
    `UPDATE jobs SET status = 'pending', locked_by = NULL, locked_at = NULL, last_error = 'Reaped: exceeded stale timeout'
     WHERE status = 'running' AND locked_at < NOW() - ($1 || ' milliseconds')::interval
     RETURNING id, job_type`,
    [String(staleTimeoutMs)]
  );
  if (result.rowCount && result.rowCount > 0) {
    logger.warn('Reaped stale jobs', { count: result.rowCount, jobs: result.rows });
  }
}

async function updateHeartbeat(workerId: string): Promise<void> {
  await query(
    `INSERT INTO sync_state (key, value) VALUES ('worker_heartbeat', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify({ workerId, at: new Date().toISOString() })]
  );
}

// ─── Scheduling helpers ──────────────────────────────────────────────────────

async function scheduleRecurring(jobType: JobType, intervalMs: number): Promise<void> {
  // Run immediately, then on interval
  await enqueueJobIfNotPending(jobType);
  setInterval(() => enqueueJobIfNotPending(jobType), intervalMs);
  logger.info(`Scheduled recurring: ${jobType} every ${intervalMs / 60000}min`);
}

async function enqueueJobIfNotPending(jobType: JobType): Promise<void> {
  // Don't enqueue if there's already a pending/running job of this type
  const existing = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM jobs WHERE job_type = $1 AND status IN ('pending', 'running')`,
    [jobType]
  );
  if (parseInt(existing.rows[0]?.count ?? '0', 10) > 0) return;
  await enqueueJob(jobType, {});
}

async function scheduleNightlyAudit(hourUtc: number): Promise<void> {
  const check = () => {
    const now = new Date();
    if (now.getUTCHours() === hourUtc && now.getUTCMinutes() < 2) {
      enqueueJobIfNotPending('full_audit');
    }
  };
  setInterval(check, 60_000); // Check every minute
  logger.info(`Scheduled nightly audit at ${hourUtc}:00 UTC`);
}

// ─── External service watchdogs ──────────────────────────────────────────────

interface WatchdogConfig {
  url: string;
  name: string;
  staleHours: number;
  timestampField: string;
}

async function runWatchdogs(watchdogs: WatchdogConfig[]): Promise<void> {
  for (const wd of watchdogs) {
    try {
      const response = await fetch(wd.url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        await insertWatchdogAlert(wd.name, `Health endpoint returned HTTP ${response.status}`);
        continue;
      }

      const data = await response.json() as Record<string, unknown>;
      const timestamp = String(data[wd.timestampField] ?? '');
      if (!timestamp) {
        await insertWatchdogAlert(wd.name, `No ${wd.timestampField} field in health response`);
        continue;
      }

      const ageMs = Date.now() - new Date(timestamp).getTime();
      const ageHours = ageMs / 3_600_000;

      if (ageHours > wd.staleHours) {
        await insertWatchdogAlert(
          wd.name,
          `Data is ${Math.round(ageHours)}h stale (threshold: ${wd.staleHours}h). Last updated: ${timestamp}`
        );
      } else {
        logger.info('Watchdog OK', { name: wd.name, ageHours: Math.round(ageHours * 10) / 10 });
      }
    } catch (err) {
      await insertWatchdogAlert(wd.name, `Health check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function insertWatchdogAlert(name: string, message: string): Promise<void> {
  // Rate-limit: don't fire the same watchdog alert more than once per 6 hours
  const recent = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM alerts WHERE category = $1 AND created_at > NOW() - interval '6 hours'`,
    [`watchdog:${name}`]
  );
  if (parseInt(recent.rows[0]?.count ?? '0', 10) > 0) return;

  await query(
    `INSERT INTO alerts (severity, category, message, metadata) VALUES ('critical', $1, $2, $3)`,
    [`watchdog:${name}`, message, JSON.stringify({ name, checkedAt: new Date().toISOString() })]
  );
  logger.warn('Watchdog alert fired', { name, message });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
