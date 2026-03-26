import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { query } from '../../db/pool';
import { logger } from '../../logger';

/**
 * Worker handler for refund_sync jobs.
 * Called when a Shopify refund webhook fires on a Mirakl order.
 * Requests refund on Mirakl (OR28) for the refunded line items.
 */
export async function handleRefundSync(payload: Record<string, unknown>): Promise<void> {
  const miraklOrderId = String(payload.mirakl_order_id ?? '');
  const refundedItems = payload.refunded_items as Array<{ sku: string; quantity: number }> | undefined;

  if (!miraklOrderId) {
    throw new Error('refund_sync: missing mirakl_order_id in payload');
  }
  if (!refundedItems || refundedItems.length === 0) {
    logger.warn('refund_sync: no refunded_items in payload, skipping', { miraklOrderId });
    return;
  }

  const config = loadConfig();
  const mirakl = new MiraklClient(config);

  // Fetch the Mirakl order to get order_line_ids for each SKU
  const miraklOrder = await mirakl.getOrder(miraklOrderId);
  const orderLines = miraklOrder.order_lines ?? [];

  const refundLines: Array<{ orderLineId: string; quantity: number }> = [];

  for (const item of refundedItems) {
    const matchingLine = orderLines.find(l => l.offer_sku === item.sku);
    if (matchingLine) {
      refundLines.push({
        orderLineId: String(matchingLine.order_line_id ?? ''),
        quantity: item.quantity,
      });
    } else {
      logger.warn('refund_sync: could not find Mirakl order line for SKU', {
        miraklOrderId,
        sku: item.sku,
      });
    }
  }

  if (refundLines.length === 0) {
    logger.error('refund_sync: no matching Mirakl order lines found', { miraklOrderId });
    return;
  }

  // OR28 — request refund
  await mirakl.requestRefund(miraklOrderId, refundLines);

  logger.info('Refund synced to Mirakl', {
    miraklOrderId,
    lineCount: refundLines.length,
  });
}
