import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { logger } from '../../logger';

/**
 * Worker handler for fulfilment_sync jobs.
 * Called when a Shopify fulfilment webhook fires on a Mirakl order.
 * Sends tracking info (OR23) and confirms shipment (OR24) on Mirakl.
 */
export async function handleFulfilmentSync(payload: Record<string, unknown>): Promise<void> {
  const miraklOrderId = String(payload.mirakl_order_id ?? '');
  const trackingNumber = String(payload.tracking_number ?? '');
  const carrierCode = String(payload.carrier_code ?? 'RM');
  const carrierName = String(payload.carrier_name ?? 'Royal Mail');
  const carrierUrl = String(payload.carrier_url ?? '');

  if (!miraklOrderId) {
    throw new Error('fulfilment_sync: missing mirakl_order_id in payload');
  }

  const config = loadConfig();
  const mirakl = new MiraklClient(config);

  // OR23 — send tracking info (if we have a tracking number)
  if (trackingNumber) {
    await mirakl.updateTracking(
      miraklOrderId,
      '', // orderLineId — applies to whole order
      trackingNumber,
      carrierCode,
      carrierName,
      carrierUrl
    );
  }

  // OR24 — confirm shipment
  await mirakl.confirmShipment(miraklOrderId);

  logger.info('Fulfilment synced to Mirakl', { miraklOrderId, trackingNumber, carrierCode });
}
