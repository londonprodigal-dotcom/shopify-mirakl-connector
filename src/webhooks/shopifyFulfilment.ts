import crypto from 'crypto';
import { Application, Request, Response, raw } from 'express';
import { AppConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { MiraklClient } from '../miraklClient';
import { query } from '../db/pool';
import { enqueueJob } from '../queue/enqueue';
import { getCorrelationId } from '../middleware/correlationId';
import { logger } from '../logger';

/**
 * Shopify fulfilment webhook handler (fulfillments/create + fulfillments/update).
 *
 * When a fulfilment is created/updated on a Shopify order that originated from
 * Mirakl, this handler:
 *   1. Looks up the Mirakl order ID from the order_map table
 *   2. Enqueues a fulfilment_sync job that will call OR23 (tracking) + OR24 (ship)
 */

/** Extract the Mirakl order ID from a Shopify order note or tags.
 *  The connector stores it as: note = "Mirakl order: DUX053069026-A"
 *  and tags include "mirakl,debenhams".
 */
function extractMiraklOrderId(note: string | null, tags: string | null): string | null {
  if (note) {
    const match = note.match(/Mirakl order:\s*(\S+)/i);
    if (match) return match[1]!;
  }
  return null;
}

/** Map Shopify carrier names to Royal Mail defaults for Louche */
function mapCarrier(trackingCompany: string | null | undefined): {
  carrierCode: string;
  carrierName: string;
  carrierUrl: string;
} {
  const company = (trackingCompany ?? '').toLowerCase();
  if (company.includes('royal mail') || company.includes('rm')) {
    return { carrierCode: 'RM', carrierName: 'Royal Mail', carrierUrl: 'https://www.royalmail.com/track-your-item' };
  }
  if (company.includes('dpd')) {
    return { carrierCode: 'DPD', carrierName: 'DPD', carrierUrl: 'https://www.dpd.co.uk/tracking' };
  }
  if (company.includes('hermes') || company.includes('evri')) {
    return { carrierCode: 'EVRI', carrierName: 'Evri', carrierUrl: 'https://www.evri.com/track' };
  }
  // Default to Royal Mail for Louche
  return { carrierCode: 'RM', carrierName: 'Royal Mail', carrierUrl: 'https://www.royalmail.com/track-your-item' };
}

interface ShopifyFulfilmentWebhookPayload {
  id: number;
  order_id: number;
  status: string;          // 'success' | 'pending' | 'cancelled' | 'error' | 'failure'
  tracking_number: string | null;
  tracking_numbers: string[];
  tracking_url: string | null;
  tracking_urls: string[];
  tracking_company: string | null;
  line_items: Array<{
    id: number;
    sku: string;
    variant_id: number;
    quantity: number;
  }>;
}

export function registerShopifyFulfilmentWebhook(
  app: Application,
  config: AppConfig,
  _shopify: ShopifyClient,
  _mirakl: MiraklClient
): void {
  app.post(
    '/webhooks/shopify/fulfilment',
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
        logger.warn('Shopify fulfilment webhook HMAC mismatch');
        res.status(401).send('Unauthorized');
        return;
      }

      const payload = JSON.parse(body.toString('utf8')) as ShopifyFulfilmentWebhookPayload;

      // Only process successful fulfilments
      if (payload.status !== 'success') {
        logger.info('Ignoring non-success fulfilment', {
          fulfilmentId: payload.id,
          orderId: payload.order_id,
          status: payload.status,
        });
        res.sendStatus(200);
        return;
      }

      // ── 2. Look up Mirakl order ID from order_map ───────────────────────────
      const correlationId = getCorrelationId();

      try {
        const mapResult = await query<{ mirakl_order_id: string }>(
          `SELECT mirakl_order_id FROM order_map WHERE shopify_order_id = $1 AND status = 'created'`,
          [payload.order_id]
        );

        if (!mapResult.rows[0]) {
          // Not a Mirakl order — ignore silently
          logger.debug('Fulfilment webhook for non-Mirakl order, skipping', {
            shopifyOrderId: payload.order_id,
          });
          res.sendStatus(200);
          return;
        }

        const miraklOrderId = mapResult.rows[0].mirakl_order_id;

        // ── 3. Dedup via fingerprint ──────────────────────────────────────────
        const fingerprint = crypto.createHash('sha256')
          .update(`fulfilment|${payload.id}|${payload.status}`)
          .digest('hex');

        const insertResult = await query(
          `INSERT INTO events (fingerprint, source, payload) VALUES ($1, 'shopify_fulfilment', $2)
           ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
          [fingerprint, JSON.stringify(payload)]
        );

        if (!insertResult.rows[0]) {
          logger.info('Duplicate fulfilment webhook, skipping', { fingerprint: fingerprint.slice(0, 12) });
          res.sendStatus(200);
          return;
        }

        const eventId = insertResult.rows[0].id as number;
        const trackingNumber = payload.tracking_number ?? payload.tracking_numbers?.[0] ?? '';
        const trackingUrl    = payload.tracking_url ?? payload.tracking_urls?.[0] ?? '';
        const carrier        = mapCarrier(payload.tracking_company);

        // ── 4. Enqueue fulfilment_sync job ────────────────────────────────────
        await enqueueJob('fulfilment_sync', {
          mirakl_order_id: miraklOrderId,
          shopify_order_id: payload.order_id,
          fulfilment_id: payload.id,
          tracking_number: trackingNumber,
          tracking_url: trackingUrl || carrier.carrierUrl,
          carrier_code: carrier.carrierCode,
          carrier_name: carrier.carrierName,
          carrier_url: carrier.carrierUrl,
        }, { eventId, correlationId });

        logger.info('Fulfilment sync enqueued', {
          miraklOrderId,
          shopifyOrderId: payload.order_id,
          trackingNumber,
          eventId,
        });

      } catch (err) {
        logger.error('Failed to persist/enqueue fulfilment event', { error: String(err) });
      }

      res.sendStatus(200);
    }
  );
}
