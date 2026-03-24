import * as crypto from 'crypto';
import { query } from '../db/pool';
import { JobType, JobRow, EnqueueOptions, RETRY_CONFIG } from './types';

export async function enqueueJob(
  jobType: JobType,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {}
): Promise<JobRow> {
  const config = RETRY_CONFIG[jobType];
  const correlationId = opts.correlationId ?? crypto.randomUUID();
  const maxAttempts = opts.maxAttempts ?? config.maxAttempts;
  const runAfter = opts.runAfter ?? new Date();

  const result = await query<JobRow & Record<string, unknown>>(
    `INSERT INTO jobs (job_type, payload, event_id, max_attempts, correlation_id, run_after)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [jobType, JSON.stringify(payload), opts.eventId ?? null, maxAttempts, correlationId, runAfter.toISOString()]
  );
  return result.rows[0]!;
}
