export type JobType =
  | 'stock_update'
  | 'create_order'
  | 'batch_sync'
  | 'check_import'
  | 'stock_reconcile'
  | 'order_reconcile'
  | 'full_audit'
  | 'catalog_monitor'
  | 'fulfilment_sync'
  | 'refund_sync';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead';

export interface JobRow {
  id: number;
  event_id: number | null;
  job_type: JobType;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  correlation_id: string;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  run_after: Date;
  locked_by: string | null;
  locked_at: Date | null;
}

export interface EnqueueOptions {
  eventId?: number;
  maxAttempts?: number;
  runAfter?: Date;
  correlationId?: string;
}

// Retry config per job type
export const RETRY_CONFIG: Record<JobType, { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }> = {
  stock_update:     { maxAttempts: 5, baseDelayMs: 30_000,  maxDelayMs: 300_000 },
  create_order:     { maxAttempts: 5, baseDelayMs: 30_000,  maxDelayMs: 300_000 },
  batch_sync:       { maxAttempts: 3, baseDelayMs: 300_000, maxDelayMs: 900_000 },
  check_import:     { maxAttempts: 10, baseDelayMs: 300_000, maxDelayMs: 300_000 },
  stock_reconcile:  { maxAttempts: 2, baseDelayMs: 120_000, maxDelayMs: 300_000 },
  order_reconcile:  { maxAttempts: 2, baseDelayMs: 120_000, maxDelayMs: 300_000 },
  full_audit:       { maxAttempts: 2, baseDelayMs: 1_800_000, maxDelayMs: 1_800_000 },
  catalog_monitor:  { maxAttempts: 2, baseDelayMs: 300_000,  maxDelayMs: 600_000 },
  fulfilment_sync:  { maxAttempts: 5, baseDelayMs: 30_000,  maxDelayMs: 300_000 },
  refund_sync:      { maxAttempts: 5, baseDelayMs: 30_000,  maxDelayMs: 300_000 },
};
