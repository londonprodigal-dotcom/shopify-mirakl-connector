import { loadConfig } from '../../config';
import { ShopifyClient } from '../../shopifyClient';
import { query } from '../../db/pool';
import { logger } from '../../logger';

/**
 * Worker handler for webhook_health jobs.
 *
 * The Shopify webhook subscriptions this service depends on were silently lost
 * on 2026-06-02 (refunds, fulfilments and inventory stopped arriving; nothing
 * alerted for four months). This job lists the subscriptions owned by our
 * client-credentials app, re-creates any that are missing, and raises a
 * critical alert whenever it has to repair one.
 *
 * Always registers the webhook-server URL, whichever process picks the job up
 * (the duplicate connector service shares this job queue).
 */

const DEFAULT_BASE_URL = 'https://webhook-server-production-aeb5.up.railway.app';

const REQUIRED: Array<{ topic: string; path: string }> = [
  { topic: 'REFUNDS_CREATE',          path: '/webhooks/shopify/refund' },
  { topic: 'FULFILLMENTS_CREATE',     path: '/webhooks/shopify/fulfilment' },
  { topic: 'FULFILLMENTS_UPDATE',     path: '/webhooks/shopify/fulfilment' },
  { topic: 'INVENTORY_LEVELS_UPDATE', path: '/webhooks/shopify/inventory' },
];

export async function handleWebhookHealth(_payload: Record<string, unknown>): Promise<void> {
  const baseUrl = (process.env.WEBHOOK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const shopify = new ShopifyClient(loadConfig());
  const existing = await shopify.listWebhookSubscriptions();

  const missing: string[] = [];
  const repaired: string[] = [];
  const failed: string[] = [];

  for (const req of REQUIRED) {
    const callbackUrl = `${baseUrl}${req.path}`;
    const present = existing.some(s => s.topic === req.topic && s.callbackUrl === callbackUrl);
    if (present) continue;

    missing.push(req.topic);
    try {
      const id = await shopify.createWebhookSubscription(req.topic, callbackUrl);
      repaired.push(req.topic);
      logger.warn('webhook_health: re-created missing subscription', { topic: req.topic, callbackUrl, id });
    } catch (err) {
      failed.push(req.topic);
      logger.error('webhook_health: could not create subscription', {
        topic: req.topic, callbackUrl, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summary = { checkedAt: new Date().toISOString(), baseUrl, missing, repaired, failed };
  await query(
    `INSERT INTO sync_state (key, value) VALUES ('webhook_health', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(summary)]
  );

  if (missing.length > 0) {
    await query(
      `INSERT INTO alerts (severity, category, message, metadata) VALUES ('critical', 'webhook_missing', $1, $2)`,
      [
        `Shopify webhook subscriptions were missing: ${missing.join(', ')}. ` +
          `Re-created: ${repaired.join(', ') || 'none'}. Failed: ${failed.join(', ') || 'none'}.`,
        JSON.stringify(summary),
      ]
    );
  }

  if (failed.length > 0) {
    throw new Error(`webhook_health: failed to create ${failed.join(', ')}`);
  }
  logger.info('webhook_health: OK', { required: REQUIRED.length, repaired: repaired.length });
}
