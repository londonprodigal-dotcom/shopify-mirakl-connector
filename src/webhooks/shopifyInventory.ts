import crypto from 'crypto';
import { Application, Request, Response, raw } from 'express';
import { AppConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { MiraklClient } from '../miraklClient';
import { ShopifyInventoryWebhookPayload } from '../types';
import { query } from '../db/pool';
import { enqueueJob } from '../queue/enqueue';
import { getCorrelationId } from '../middleware/correlationId';
import { logger } from '../logger';

export function registerShopifyInventoryWebhook(
  app: Application,
  config: AppConfig,
  shopify: ShopifyClient,
  _mirakl: MiraklClient  // kept for API compat but no longer used directly
): void {
  app.post(
    '/webhooks/shopify/inventory',
    raw({ type: 'application/json' }),
    async (req: Request, res: Response): Promise<void> => {
      // ── 1. Verify HMAC (unchanged) ──────────────────────────────────────────
      const secret = config.shopify.webhookSecret;
      const hmac   = req.headers['x-shopify-hmac-sha256'] as string | undefined;
      const body   = req.body as Buffer;

      if (!secret) {
        logger.error('SHOPIFY_WEBHOOK_SECRET not configured');
        res.status(500).send('Server misconfiguration');
        return;
      }

      const computed = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('base64');

      const computedBuf = Buffer.from(computed);
      const receivedBuf = Buffer.from(hmac ?? '');
      const valid =
        computedBuf.length === receivedBuf.length &&
        crypto.timingSafeEqual(computedBuf, receivedBuf);

      if (!valid) {
        logger.warn('Shopify webhook HMAC mismatch');
        res.status(401).send('Unauthorized');
        return;
      }

      const payload = JSON.parse(body.toString('utf8')) as ShopifyInventoryWebhookPayload;

      // ── 2. Compute fingerprint for dedup ────────────────────────────────────
      const fingerprint = crypto.createHash('sha256')
        .update(`${payload.inventory_item_id}|${payload.location_id}|${payload.available}|${payload.updated_at ?? ''}`)
        .digest('hex');

      // ── 3. Persist event (dedup via UNIQUE constraint) ──────────────────────
      const correlationId = getCorrelationId();
      try {
        const insertResult = await query(
          `INSERT INTO events (fingerprint, source, payload) VALUES ($1, 'shopify_inventory', $2)
           ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
          [fingerprint, JSON.stringify(payload)]
        );

        if (!insertResult.rows[0]) {
          logger.info('Duplicate inventory webhook, skipping', { fingerprint: fingerprint.slice(0, 12) });
          res.sendStatus(200);
          return;
        }

        const eventId = insertResult.rows[0].id as number;

        // ── 4. Look up SKU (need it for the job payload) ──────────────────────
        const sku = await shopify.lookupSkuByInventoryItem(payload.inventory_item_id);
        if (!sku) {
          logger.warn('No SKU for inventory item', { inventory_item_id: payload.inventory_item_id });
          res.sendStatus(200);
          return;
        }

        // ── 5. Enqueue stock_update job ───────────────────────────────────────
        await enqueueJob('stock_update', { sku, quantity: payload.available }, { eventId, correlationId });
        logger.info('Stock update enqueued', { sku, available: payload.available, eventId });

      } catch (err) {
        logger.error('Failed to persist/enqueue inventory event', { error: String(err) });
        // Still respond 200 to prevent Shopify retries flooding us
        // The event may or may not have been persisted
      }

      res.sendStatus(200);
    }
  );
}
