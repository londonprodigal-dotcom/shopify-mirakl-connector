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
import { logHmacMismatch } from './hmacRateLimit';
import { verifyShopifyHmac } from './verifyHmac';

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
      // ── 1. Verify HMAC against any configured secret ───────────────────────
      const secrets = config.shopify.webhookSecrets;
      const hmac    = req.headers['x-shopify-hmac-sha256'] as string | undefined;
      const body    = req.body as Buffer;

      if (secrets.length === 0) {
        logger.error('No Shopify webhook secrets configured');
        res.status(500).send('Server misconfiguration');
        return;
      }

      if (!verifyShopifyHmac(body, hmac, secrets)) {
        logHmacMismatch('inventory');
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

        // ── 4. Look up SKU + product tags ─────────────────────────────────────
        const lookup = await shopify.lookupSkuByInventoryItem(payload.inventory_item_id);
        if (!lookup) {
          logger.warn('No SKU for inventory item', { inventory_item_id: payload.inventory_item_id });
          res.sendStatus(200);
          return;
        }
        const { sku, productTags } = lookup;

        // ── 5. Tag gate ───────────────────────────────────────────────────────
        // fetchAllProducts (bulk batch_sync) filters to `tag:debenhams`. Mirror
        // that here so full-price Louche products don't churn through stock_update
        // → Mirakl reject → pending_catalog. The previous behaviour pushed every
        // SKU and orphaned the ones Mirakl couldn't find — visible as 28 stuck
        // catalog_orphan rows on 2026-05-11.
        if (!productTags.includes('debenhams')) {
          logger.info('Inventory webhook skipped — product not tagged debenhams', {
            sku, eventId, available: payload.available,
          });
          res.sendStatus(200);
          return;
        }

        // ── 6. Enqueue stock_update job ───────────────────────────────────────
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
