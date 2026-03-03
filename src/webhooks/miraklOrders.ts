import { Application, Request, Response, json } from 'express';
import { AppConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { MiraklClient } from '../miraklClient';
import { logger } from '../logger';

// Mirakl order states that represent a confirmed, payable sale
const ACTIONABLE_STATES = new Set([
  'WAITING_DEBIT_PAYMENT',
  'WAITING_ACCEPTANCE',
  'SHIPPING',
  'SHIPPED',
  'TO_COLLECT',
  'RECEIVED',
]);

export function registerMiraklOrdersWebhook(
  app: Application,
  _config: AppConfig,
  shopify: ShopifyClient,
  mirakl: MiraklClient
): void {
  app.post(
    '/webhooks/mirakl/orders',
    json({ limit: '1mb' }),
    (req: Request, res: Response): void => {
      // Mirakl doesn't sign notifications — validate the order_id exists
      const body    = req.body as Record<string, unknown>;
      const orderId = body.order_id as string | undefined;

      if (!orderId) {
        logger.warn('Mirakl notification missing order_id', body);
        res.status(400).json({ error: 'order_id required' });
        return;
      }

      // Respond immediately before any async work
      res.sendStatus(200);

      logger.info('Mirakl order notification received', {
        order_id:          orderId,
        notification_type: body.notification_type,
      });

      void (async () => {
        try {
          const order = await mirakl.getOrder(orderId);
          const state = order.order_state ?? order.status ?? '';

          if (!ACTIONABLE_STATES.has(state)) {
            logger.info('Mirakl order in non-actionable state — skipping', {
              orderId,
              state,
            });
            return;
          }

          logger.info('Creating Shopify order from Mirakl sale', {
            orderId,
            state,
            lines: order.order_lines.length,
          });

          const shopifyOrder = await shopify.createOrderFromMirakl(order);
          logger.info('Shopify order created', {
            shopifyOrderId:   shopifyOrder.id,
            shopifyOrderName: shopifyOrder.name,
            miraklOrderId:    orderId,
          });
        } catch (err) {
          logger.error('Mirakl order webhook processing failed', {
            orderId,
            error: String(err),
          });
        }
      })();
    }
  );
}
