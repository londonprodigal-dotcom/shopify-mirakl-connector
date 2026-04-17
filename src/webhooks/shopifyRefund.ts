import crypto from 'crypto';
import { Application, Request, Response, raw } from 'express';
import { AppConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { MiraklClient } from '../miraklClient';
import { query } from '../db/pool';
import { enqueueJob } from '../queue/enqueue';
import { getCorrelationId } from '../middleware/correlationId';
import { logger } from '../logger';
import { logHmacMismatch } from './hmacRateLimit';

/**
 * Shopify refund webhook handler (refunds/create).
 *
 * When a refund is created on a Shopify order that originated from Mirakl,
 * this handler:
 *   1. Looks up the Mirakl order ID from the order_map table
 *   2. Fetches the Mirakl order to map Shopify line items → Mirakl order line IDs
 *   3. Enqueues a refund_sync job that will call OR28 (refund request)
 */

interface ShopifyRefundLineItem {
  line_item_id: number;
  quantity: number;
  line_item: {
    id: number;
    sku: string;
    variant_id: number;
    quantity: number;
    name: string;
  };
}

interface ShopifyRefundWebhookPayload {
  id: number;
  order_id: number;
  created_at: string;
  note: string | null;
  refund_line_items: ShopifyRefundLineItem[];
  transactions: Array<{
    id: number;
    amount: string;
    kind: string;   // 'refund'
    status: string; // 'success'
  }>;
}

export function registerShopifyRefundWebhook(
  app: Application,
  config: AppConfig,
  shopify: ShopifyClient,
  _mirakl: MiraklClient
): void {
  app.post(
    '/webhooks/shopify/refund',
    raw({ type: 'application/json' }),
    async (req: Request, res: Response): Promise<void> => {
      // ── 1. Verify HMAC ──────────────────────────────────────────────────────
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
        logHmacMismatch('refund');
        res.status(401).send('Unauthorized');
        return;
      }

      const payload = JSON.parse(body.toString('utf8')) as ShopifyRefundWebhookPayload;

      // ── 2. Look up Mirakl order ID from order_map ───────────────────────────
      const correlationId = getCorrelationId();

      try {
        const mapResult = await query<{ mirakl_order_id: string }>(
          `SELECT mirakl_order_id FROM order_map WHERE shopify_order_id = $1 AND status = 'created'`,
          [payload.order_id]
        );

        if (!mapResult.rows[0]) {
          // Not a Mirakl order — ignore silently
          logger.debug('Refund webhook for non-Mirakl order, skipping', {
            shopifyOrderId: payload.order_id,
          });
          res.sendStatus(200);
          return;
        }

        const miraklOrderId = mapResult.rows[0].mirakl_order_id;

        if (!payload.refund_line_items || payload.refund_line_items.length === 0) {
          logger.info('Refund webhook has no line items, skipping', {
            refundId: payload.id,
            orderId: payload.order_id,
          });
          res.sendStatus(200);
          return;
        }

        // ── 3. Dedup via fingerprint ──────────────────────────────────────────
        const fingerprint = crypto.createHash('sha256')
          .update(`refund|${payload.id}`)
          .digest('hex');

        const insertResult = await query(
          `INSERT INTO events (fingerprint, source, payload) VALUES ($1, 'shopify_refund', $2)
           ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
          [fingerprint, JSON.stringify(payload)]
        );

        if (!insertResult.rows[0]) {
          logger.info('Duplicate refund webhook, skipping', { fingerprint: fingerprint.slice(0, 12) });
          res.sendStatus(200);
          return;
        }

        const eventId = insertResult.rows[0].id as number;

        // Build refund lines: SKU + quantity (the worker will resolve to Mirakl order line IDs)
        const refundLines = payload.refund_line_items.map(rli => ({
          sku: rli.line_item.sku,
          quantity: rli.quantity,
          shopify_line_item_id: rli.line_item_id,
        }));

        // ── 4. Enqueue refund_sync job ────────────────────────────────────────
        await enqueueJob('refund_sync', {
          mirakl_order_id: miraklOrderId,
          shopify_order_id: payload.order_id,
          refund_id: payload.id,
          refund_lines: refundLines,
          note: payload.note,
        }, { eventId, correlationId });

        logger.info('Refund sync enqueued', {
          miraklOrderId,
          shopifyOrderId: payload.order_id,
          refundId: payload.id,
          lineCount: refundLines.length,
          eventId,
        });

      } catch (err) {
        logger.error('Failed to persist/enqueue refund event', { error: String(err) });
      }

      res.sendStatus(200);
    }
  );
}
