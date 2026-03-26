import express from 'express';
import sharp from 'sharp';
import { AppConfig } from './config';
import { ShopifyClient } from './shopifyClient';
import { MiraklClient } from './miraklClient';
import { registerShopifyInventoryWebhook } from './webhooks/shopifyInventory';
import { registerMiraklOrdersWebhook } from './webhooks/miraklOrders';
import { registerShopifyFulfilmentWebhook } from './webhooks/shopifyFulfilment';
import { registerShopifyRefundWebhook } from './webhooks/shopifyRefund';
import { correlationMiddleware } from './middleware/correlationId';
import { runMigrations } from './db/migrate';
import { query } from './db/pool';
import { logger } from './logger';

export async function startServer(config: AppConfig): Promise<void> {
  const app     = express();
  const shopify = new ShopifyClient(config);
  const mirakl  = new MiraklClient(config);

  // ── Run DB migrations on startup ──────────────────────────────────────────
  if (config.hardening.databaseUrl) {
    await runMigrations();
    logger.info('Database migrations complete');
  }

  // ── Correlation ID middleware (before all routes) ─────────────────────────
  app.use(correlationMiddleware);

  // ── Health check ───────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ── Deep health check (queue stats + worker heartbeat) ────────────────────
  app.get('/health/deep', async (_req, res) => {
    try {
      const [queueStats, heartbeat] = await Promise.all([
        query<{ status: string; cnt: string }>(
          `SELECT status, COUNT(*)::text AS cnt FROM jobs GROUP BY status`
        ),
        query<{ value: unknown }>(
          `SELECT value FROM sync_state WHERE key = 'worker_heartbeat'`
        ),
      ]);

      const queue: Record<string, number> = {};
      for (const row of queueStats.rows) {
        queue[row.status] = parseInt(row.cnt, 10);
      }

      const workerHeartbeat = heartbeat.rows[0]?.value ?? null;
      const pending = queue['pending'] ?? 0;
      const running = queue['running'] ?? 0;
      const dead = queue['dead'] ?? 0;

      // Determine health status
      let status: 'ok' | 'warn' | 'critical' = 'ok';
      if (pending > config.hardening.queueBacklogCrit || dead > 0) {
        status = 'critical';
      } else if (pending > config.hardening.queueBacklogWarn) {
        status = 'warn';
      }

      res.json({
        status,
        ts: new Date().toISOString(),
        queue: { pending, running, dead, ...queue },
        workerHeartbeat,
      });
    } catch (err) {
      logger.error('Deep health check failed', { error: String(err) });
      res.status(503).json({ status: 'error', error: 'Database unavailable' });
    }
  });

  // ── Image proxy — converts to JPEG at 72 DPI for Mirakl compliance ────────
  app.get('/img', async (req, res) => {
    const url = req.query.url as string | undefined;
    if (!url || !url.startsWith('https://cdn.shopify.com/')) {
      res.status(400).json({ error: 'Missing or invalid ?url= parameter (must be Shopify CDN)' });
      return;
    }
    try {
      // Request JPEG from Shopify CDN (avoids webp which Mirakl may not support)
      const jpegUrl = url.includes('format=') ? url
        : url + (url.includes('?') ? '&' : '?') + 'format=pjpg';

      const response = await fetch(jpegUrl);
      if (!response.ok) {
        res.status(502).json({ error: `Upstream returned ${response.status}` });
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());

      // Lightweight: only rewrite DPI metadata to 72, no re-encoding or resizing
      const fixed = await sharp(buffer)
        .withMetadata({ density: 72 })
        .jpeg({ quality: 90 })
        .toBuffer();

      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
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
  registerShopifyFulfilmentWebhook(app, config, shopify, mirakl);
  registerShopifyRefundWebhook(app, config, shopify, mirakl);

  // ── 404 fallback ───────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const { port } = config.server;
  app.listen(port, () => {
    logger.info('Webhook server listening', { port });
    logger.info('  GET  /health');
    logger.info('  GET  /health/deep                — Queue stats + worker heartbeat');
    logger.info('  GET  /img?url=<shopify-cdn-url>   — Image proxy (DPI rewrite to 72)');
    logger.info('  POST /webhooks/shopify/inventory   — Shopify stock changes → Mirakl OF01');
    logger.info('  POST /webhooks/mirakl/orders       — Mirakl sale → Shopify order');
    logger.info('  POST /webhooks/shopify/fulfilment  — Shopify fulfilment → Mirakl OR23+OR24');
    logger.info('  POST /webhooks/shopify/refund      — Shopify refund → Mirakl OR28');
  });
}
