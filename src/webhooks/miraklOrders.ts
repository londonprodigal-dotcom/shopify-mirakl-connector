import crypto from 'crypto';
import { Application, Request, Response, json } from 'express';
import { AppConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { MiraklClient } from '../miraklClient';
import { query } from '../db/pool';
import { enqueueJob } from '../queue/enqueue';
import { getCorrelationId } from '../middleware/correlationId';
import { logger } from '../logger';

export function registerMiraklOrdersWebhook(
  app: Application,
  _config: AppConfig,
  _shopify: ShopifyClient,
  _mirakl: MiraklClient
): void {
  app.post(
    '/webhooks/mirakl/orders',
    json({ limit: '1mb' }),
    async (req: Request, res: Response): Promise<void> => {
      const body = req.body as Record<string, unknown>;
      const orderId = body.order_id as string | undefined;

      if (!orderId) {
        logger.warn('Mirakl notification missing order_id');
        res.status(400).json({ error: 'order_id required' });
        return;
      }

      // Fingerprint: order_id + notification_type (state changes produce different fingerprints)
      const notificationType = String(body.notification_type ?? body.order_state ?? 'unknown');
      const fingerprint = crypto.createHash('sha256')
        .update(`${orderId}|${notificationType}`)
        .digest('hex');

      const correlationId = getCorrelationId();

      try {
        const insertResult = await query(
          `INSERT INTO events (fingerprint, source, payload) VALUES ($1, 'mirakl_order', $2)
           ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
          [fingerprint, JSON.stringify(body)]
        );

        if (!insertResult.rows[0]) {
          logger.info('Duplicate Mirakl order notification, skipping', { orderId, fingerprint: fingerprint.slice(0, 12) });
          res.sendStatus(200);
          return;
        }

        const eventId = insertResult.rows[0].id as number;
        await enqueueJob('create_order', { mirakl_order_id: orderId }, { eventId, correlationId });
        logger.info('Order creation enqueued', { orderId, eventId });

      } catch (err) {
        logger.error('Failed to persist/enqueue order event', { error: String(err) });
      }

      res.sendStatus(200);
    }
  );
}
