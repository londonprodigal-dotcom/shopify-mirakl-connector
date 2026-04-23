import { query } from '../db/pool';
import { JobRow, RETRY_CONFIG } from './types';

export async function markCompleted(jobId: number): Promise<void> {
  await query(
    `UPDATE jobs SET status = 'completed', completed_at = NOW(), locked_by = NULL, locked_at = NULL WHERE id = $1`,
    [jobId]
  );
}

export async function markSkipped(jobId: number, reason: string): Promise<void> {
  await query(
    `UPDATE jobs SET status = 'skipped', last_error = $2, completed_at = NOW(), locked_by = NULL, locked_at = NULL WHERE id = $1`,
    [jobId, reason]
  );
}

export async function markFailed(job: JobRow, error: string): Promise<'retrying' | 'dead'> {
  const config = RETRY_CONFIG[job.job_type];
  const isDead = job.attempts >= job.max_attempts;

  if (isDead) {
    await query(
      `UPDATE jobs SET status = 'dead', last_error = $2, locked_by = NULL, locked_at = NULL WHERE id = $1`,
      [job.id, error]
    );
    return 'dead';
  }

  // Exponential backoff: base * 2^(attempt-1), capped at max
  const delayMs = Math.min(config.baseDelayMs * Math.pow(2, job.attempts - 1), config.maxDelayMs);
  const runAfter = new Date(Date.now() + delayMs);

  await query(
    `UPDATE jobs SET status = 'pending', last_error = $2, locked_by = NULL, locked_at = NULL, run_after = $3 WHERE id = $1`,
    [job.id, error, runAfter.toISOString()]
  );
  return 'retrying';
}
