import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { logger } from '../../logger';

/**
 * Worker handler for refund_sync jobs.
 * Called when a Shopify refund webhook fires on a Mirakl order.
 * Requests refund on Mirakl (OR29) for the refunded line items.
 */
export async function handleRefundSync(payload: Record<string, unknown>): Promise<void> {
  const miraklOrderId = String(payload.mirakl_order_id ?? '');
  const webhookLines = payload.refund_lines as
    | Array<{
        sku: string;
        quantity: number;
        shopify_line_item_id?: number;
        amount?: number;
        currency?: string;
      }>
    | undefined;

  if (!miraklOrderId) {
    throw new Error('refund_sync: missing mirakl_order_id in payload');
  }
  if (!webhookLines || webhookLines.length === 0) {
    logger.warn('refund_sync: no refund_lines in payload, skipping', { miraklOrderId });
    return;
  }

  const config = loadConfig();
  const mirakl = new MiraklClient(config);

  const miraklOrder = await mirakl.getOrder(miraklOrderId);
  const orderLines = miraklOrder.order_lines ?? [];

  const refundLines: Array<{
    orderLineId: string;
    quantity: number;
    amount: number;
    currencyIsoCode: string;
  }> = [];

  for (const item of webhookLines) {
    const matchingLine = orderLines.find(l => l.offer_sku === item.sku);
    if (!matchingLine) {
      logger.warn('refund_sync: could not find Mirakl order line for SKU', {
        miraklOrderId,
        sku: item.sku,
      });
      continue;
    }

    // Derive amount: webhook payload (new) or fall back to Mirakl line price × qty
    // (older jobs enqueued before the webhook fields were added still work).
    const miraklLinePrice = Number(matchingLine.price ?? matchingLine.total_price ?? 0);
    const fallbackAmount = miraklLinePrice * item.quantity;
    const amount = typeof item.amount === 'number' && item.amount > 0 ? item.amount : fallbackAmount;
    const currencyIsoCode = item.currency ?? String(miraklOrder.currency_iso_code ?? 'GBP');

    if (amount <= 0) {
      logger.error('refund_sync: cannot resolve refund amount', {
        miraklOrderId, sku: item.sku, quantity: item.quantity,
      });
      continue;
    }

    refundLines.push({
      orderLineId: String(matchingLine.order_line_id ?? ''),
      quantity: item.quantity,
      amount,
      currencyIsoCode,
    });
  }

  if (refundLines.length === 0) {
    logger.error('refund_sync: no matching Mirakl order lines found', { miraklOrderId });
    return;
  }

  await mirakl.requestRefund(miraklOrderId, refundLines);

  logger.info('Refund synced to Mirakl', {
    miraklOrderId,
    lineCount: refundLines.length,
    totalAmount: refundLines.reduce((s, l) => s + l.amount, 0),
  });
}
