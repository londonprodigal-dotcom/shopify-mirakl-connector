import express from 'express';
import sharp from 'sharp';
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

  // ── Image proxy — rewrites DPI metadata to 72 for Mirakl compliance ───────
  app.get('/img', async (req, res) => {
    const url = req.query.url as string | undefined;
    if (!url || !url.startsWith('https://cdn.shopify.com/')) {
      res.status(400).json({ error: 'Missing or invalid ?url= parameter (must be Shopify CDN)' });
      return;
    }
    try {
      const response = await fetch(url);
      if (!response.ok) {
        res.status(502).json({ error: `Upstream returned ${response.status}` });
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      // Rewrite DPI metadata to 72 using sharp — no re-encoding, just metadata fix
      const fixed = await sharp(buffer)
        .withMetadata({ density: 72 })
        .toBuffer();
      const contentType = response.headers.get('content-type') ?? 'image/jpeg';
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=86400'); // 24h cache
      res.send(fixed);
    } catch (err) {
      logger.error('Image proxy error', { url, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to proxy image' });
    }
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
    logger.info('  GET  /img?url=<shopify-cdn-url>   — Image proxy (DPI rewrite to 72)');
    logger.info('  POST /webhooks/shopify/inventory  — Shopify stock changes → Mirakl OF01');
    logger.info('  POST /webhooks/mirakl/orders      — Mirakl sale → Shopify order');
  });
}
