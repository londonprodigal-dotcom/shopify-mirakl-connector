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
  scheduleNightlyAudit(config.hardening.fullAuditHourUtc);

  // Alert dispatcher (every 30s) — sends to webhook and/or email via Resend
  const alertConfig = {
    webhookUrl: config.hardening.alertWebhookUrl,
    emailTo: config.hardening.alertEmailTo,
    resendApiKey: config.hardening.resendApiKey,
    resendFrom: config.hardening.resendFrom,
  };
  setInterval(() => dispatchAlerts(alertConfig), 30_000);

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
