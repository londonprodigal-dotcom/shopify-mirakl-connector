import { query } from '../db/pool';
import { JobRow } from './types';

export async function dequeueJob(workerId: string): Promise<JobRow | null> {
  const result = await query<JobRow & Record<string, unknown>>(
    `UPDATE jobs
     SET status = 'running', attempts = attempts + 1, started_at = NOW(),
         locked_by = $1, locked_at = NOW()
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'pending' AND run_after <= NOW()
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [workerId]
  );
  return result.rows[0] ?? null;
}
