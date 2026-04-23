import { JobRow } from '../queue/types';
import { handleStockUpdate } from './handlers/stockUpdate';
import { handleCreateOrder } from './handlers/createOrder';
import { handleStockReconcile } from './handlers/stockReconcile';
import { handleOrderReconcile } from './handlers/orderReconcile';
import { handleFullAudit } from './handlers/fullAudit';
import { handleCheckImport } from './handlers/checkImport';
import { handleCatalogMonitor } from './handlers/catalogMonitor';
import { handleFulfilmentSync } from './handlers/fulfilmentSync';
import { handleRefundSync } from './handlers/refundSync';
import { handleBatchSync } from './handlers/batchSync';
import { handleResurrectionPoll } from './handlers/resurrectionPoller';
import { handleWeeklyTriage } from './handlers/weeklyTriage';
import { logger } from '../logger';

type Handler = (payload: Record<string, unknown>) => Promise<void>;

const handlers: Record<string, Handler> = {
  stock_update: handleStockUpdate,
  create_order: handleCreateOrder,
  batch_sync: handleBatchSync,
  stock_reconcile: handleStockReconcile,
  order_reconcile: handleOrderReconcile,
  full_audit: handleFullAudit,
  check_import: handleCheckImport,
  catalog_monitor: handleCatalogMonitor,
  fulfilment_sync: handleFulfilmentSync,
  refund_sync: handleRefundSync,
  resurrection_poll: handleResurrectionPoll,
  weekly_triage: handleWeeklyTriage,
};

export async function processJob(job: JobRow): Promise<void> {
  const handler = handlers[job.job_type];
  if (!handler) {
    throw new Error(`No handler registered for job type: ${job.job_type}`);
  }
  await handler(job.payload);
}
