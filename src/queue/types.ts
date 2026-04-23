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
  | 'refund_sync'
  | 'resurrection_poll'
  | 'weekly_triage';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead' | 'skipped';

/**
 * Signals that Mirakl returned a permanent rejection that will not be fixed by retrying
 * (e.g. "The state of the product is unknown" for an orphan offer-sku). The worker loop
 * marks these jobs 'skipped' instead of dead-lettering, and raises a low-severity
 * catalog_orphan alert rather than a critical dead-letter alert.
 */
export class TerminalMiraklError extends Error {
  readonly code: string;
  readonly sku?: string;
  readonly importId?: string | number;
  readonly miraklErrorCode?: string;
  readonly errorRow?: Record<string, string>;
  constructor(
    message: string,
    opts: {
      code: string;
      sku?: string;
      importId?: string | number;
      miraklErrorCode?: string;
      errorRow?: Record<string, string>;
    }
  ) {
    super(message);
    this.name = 'TerminalMiraklError';
    this.code = opts.code;
    this.sku = opts.sku;
    this.importId = opts.importId;
    this.miraklErrorCode = opts.miraklErrorCode;
    this.errorRow = opts.errorRow;
  }
}

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
  // Recurring poller: one OF52 export + optional Shopify read + re-enqueue.
  // Low attempts because the next scheduled run (hourly) is cheaper than retrying.
  resurrection_poll: { maxAttempts: 2, baseDelayMs: 120_000, maxDelayMs: 300_000 },
  // Weekly operator-triage email — rare (Mon 08:00 UTC); retry twice if Resend hiccups.
  weekly_triage:     { maxAttempts: 2, baseDelayMs: 300_000, maxDelayMs: 600_000 },
};
