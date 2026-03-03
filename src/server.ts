import express from 'express';
import { AppConfig } from './config';
import { ShopifyClient } from './shopifyClient';
import { MiraklClient } from './miraklClient';
import { registerShopifyInventoryWebhook } from './webhooks/shopifyInventory';
import { registerMiraklOrdersWebhook } from './webhooks/miraklOrders';
import { logger } from './logger';

export function startServer(config: AppConfig): void {
  const app     = express();
  const shopify = new ShopifyClient(config);
  const mirakl  = new MiraklClient(config);

  // ── Health check ───────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ── Webhook routes ─────────────────────────────────────────────────────────
  // Note: each handler registers its own body parser middleware at the route
  // level, so raw Buffer and JSON parsing don't interfere with each other.
  registerShopifyInventoryWebhook(app, config, shopify, mirakl);
  registerMiraklOrdersWebhook(app, config, shopify, mirakl);

  // ── 404 fallback ───────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const { port } = config.server;
  app.listen(port, () => {
    logger.info('Webhook server listening', { port });
    logger.info('  GET  /health');
    logger.info('  POST /webhooks/shopify/inventory  — Shopify stock changes → Mirakl OF01');
    logger.info('  POST /webhooks/mirakl/orders      — Mirakl sale → Shopify order');
  });
}
