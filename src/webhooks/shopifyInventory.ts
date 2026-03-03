import crypto from 'crypto';
import { Application, Request, Response, raw } from 'express';
import { AppConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { MiraklClient } from '../miraklClient';
import { ShopifyInventoryWebhookPayload } from '../types';
import { logger } from '../logger';

export function registerShopifyInventoryWebhook(
  app: Application,
  config: AppConfig,
  shopify: ShopifyClient,
  mirakl: MiraklClient
): void {
  // express.raw() captures the body as a Buffer — required for HMAC verification
  app.post(
    '/webhooks/shopify/inventory',
    raw({ type: 'application/json' }),
    (req: Request, res: Response): void => {
      // ── 1. Verify HMAC ─────────────────────────────────────────────────────
      const secret = config.shopify.webhookSecret;
      const hmac   = req.headers['x-shopify-hmac-sha256'] as string | undefined;
      const body   = req.body as Buffer;

      if (!secret) {
        logger.error('SHOPIFY_WEBHOOK_SECRET not configured — rejecting webhook');
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
        logger.warn('Shopify webhook HMAC mismatch — rejected');
        res.status(401).send('Unauthorized');
        return;
      }

      // ── 2. Respond immediately (Shopify requires < 5 s) ────────────────────
      const payload = JSON.parse(body.toString('utf8')) as ShopifyInventoryWebhookPayload;
      res.sendStatus(200);

      logger.info('Shopify inventory webhook received', {
        inventory_item_id: payload.inventory_item_id,
        available:         payload.available,
      });

      // ── 3. Process asynchronously ───────────────────────────────────────────
      void (async () => {
        try {
          const sku = await shopify.lookupSkuByInventoryItem(payload.inventory_item_id);
          if (!sku) {
            logger.warn('No SKU for inventory item — skipping', {
              inventory_item_id: payload.inventory_item_id,
            });
            return;
          }
          await mirakl.pushStockUpdate(sku, payload.available);
          logger.info('Stock update complete', { sku, available: payload.available });
        } catch (err) {
          logger.error('Inventory webhook processing failed', { error: String(err) });
        }
      })();
    }
  );
}
