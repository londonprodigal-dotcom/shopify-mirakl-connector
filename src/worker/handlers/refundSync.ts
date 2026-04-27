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

    // Mirakl OR29 `amount` must be ≤ the line's refundable amount as Mirakl knows
    // it. On Debenhams (and most Mirakl operators) that's the merchant-net price,
    // not the customer-paid price — Debenhams has already deducted its commission
    // on order creation. Trusting Shopify's gross subtotal here causes 400
    // "amount exceeds refundable" rejections, so we authoritatively use Mirakl's
    // own line.price × quantity. (Shopify amount kept in logs for audit.)
    const lineQty = Number(matchingLine.quantity) || 1;
    const unitPrice = matchingLine.price != null
      ? Number(matchingLine.price)
      : Number(matchingLine.total_price ?? 0) / lineQty;
    const amount = Math.round(unitPrice * item.quantity * 100) / 100;
    const currencyIsoCode = String(miraklOrder.currency_iso_code ?? item.currency ?? 'GBP');

    if (amount <= 0) {
      logger.error('refund_sync: cannot resolve refund amount from Mirakl line', {
        miraklOrderId, sku: item.sku, miraklUnitPrice: unitPrice, quantity: item.quantity,
      });
      continue;
    }

    if (typeof item.amount === 'number' && Math.abs(item.amount - amount) > 0.01) {
      logger.info('refund_sync: Shopify gross differs from Mirakl-net refund amount', {
        miraklOrderId, sku: item.sku, shopifyAmount: item.amount, miraklAmount: amount,
      });
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
