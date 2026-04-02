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

      // Ensure minimum 1200px width for Debenhams, rewrite DPI to 72
      const metadata = await sharp(buffer).metadata();
      let pipeline = sharp(buffer).withMetadata({ density: 72 });
      if (metadata.width && metadata.width < 1200) {
        pipeline = pipeline.resize({ width: 1200, withoutEnlargement: false });
      }
      const fixed = await pipeline
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

  // ── Admin: Audit offer→product linkage ──────────────────────────────────────
  // Runs OF52 async export, fetches all Shopify variants, cross-references
  // to find offers linked to wrong products (SKU→EAN mismatch).
  app.get('/admin/audit-linkage', async (_req, res) => {
    try {
      logger.info('[audit-linkage] Starting linkage audit');

      // 1. Fetch all Mirakl offers via OF52 (async, no rate limit)
      const miraklOffers = await mirakl.fetchAllOffers();
      logger.info('[audit-linkage] Mirakl offers fetched', { count: miraklOffers.length });

      // 2. Fetch all Shopify variants (SKU → barcode + title + price)
      const shopifyData = await shopify.fetchAllInventoryAndPrices();
      const allProducts = await shopify.fetchAllProducts();

      // Build SKU → { barcode, productTitle, price } map from Shopify
      const shopifyMap = new Map<string, { barcode: string; productTitle: string; price: string }>();
      for (const product of allProducts) {
        for (const variant of product.variants) {
          if (variant.sku) {
            shopifyMap.set(variant.sku, {
              barcode: variant.barcode ?? '',
              productTitle: product.title,
              price: variant.price,
            });
          }
        }
      }
      logger.info('[audit-linkage] Shopify products fetched', { skuCount: shopifyMap.size });

      // 3. Cross-reference: for each Mirakl offer, check if product_sku matches expected barcode
      // OF52 CSV has product-sku which is "M" + EAN in Debenhams
      // We need the full OF52 data with product-sku — refetch with raw CSV parsing
      const axios = (mirakl as any).http;
      const exportRes = await axios.post('/api/offers/export/async', {},
        { headers: { 'Content-Type': 'application/json' } });
      const trackingId = exportRes.data.tracking_id;

      // Poll OF53
      let downloadUrls: string[] = [];
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const statusRes = await axios.get(`/api/offers/export/async/status/${trackingId}`);
        if (statusRes.data.status === 'COMPLETED') {
          downloadUrls = statusRes.data.urls ?? [];
          break;
        }
        if (statusRes.data.status === 'FAILED') throw new Error('OF52 export failed');
        await new Promise(r => setTimeout(r, 5000));
      }

      // Download OF54 and parse
      const mismatches: Array<{
        shop_sku: string;
        mirakl_product_sku: string;
        mirakl_product_title: string;
        mirakl_price: number;
        shopify_barcode: string;
        shopify_product_title: string;
        shopify_price: string;
        issue: string;
      }> = [];
      let totalChecked = 0;

      for (const url of downloadUrls) {
        const csvRes = await axios.get(url, { responseType: 'text' as const });
        const lines = (csvRes.data as string).split(/\r?\n/).filter((l: string) => l.trim());
        if (lines.length < 2) continue;

        const delimiter = lines[0].includes('\t') ? '\t' : ';';
        const headers = lines[0].split(delimiter).map((h: string) => h.replace(/^"|"$/g, '').toLowerCase().trim());
        const skuIdx = headers.indexOf('shop-sku');
        const prodSkuIdx = headers.indexOf('product-sku');
        const titleIdx = headers.indexOf('product-title') >= 0 ? headers.indexOf('product-title') : -1;
        const priceIdx = headers.indexOf('price');

        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(delimiter).map((c: string) => c.replace(/^"|"$/g, ''));
          const shopSku = cols[skuIdx] ?? '';
          const miraklProductSku = cols[prodSkuIdx] ?? '';
          const miraklTitle = titleIdx >= 0 ? (cols[titleIdx] ?? '') : '';
          const miraklPrice = priceIdx >= 0 ? parseFloat(cols[priceIdx] ?? '0') : 0;

          if (!shopSku) continue;
          totalChecked++;

          const shopifyInfo = shopifyMap.get(shopSku);
          if (!shopifyInfo) continue; // SKU not in Shopify, skip

          // Check 1: Does the Mirakl product_sku contain the correct barcode?
          // Debenhams uses "M" + EAN as product_sku
          const expectedProductSku = 'M' + shopifyInfo.barcode;
          const issues: string[] = [];

          if (shopifyInfo.barcode && miraklProductSku && miraklProductSku !== expectedProductSku) {
            issues.push(`EAN_MISMATCH: mirakl=${miraklProductSku} expected=${expectedProductSku}`);
          }

          // Check 2: Does the product title match?
          if (miraklTitle && shopifyInfo.productTitle) {
            // Strip colour suffix for fuzzy match (titles may differ slightly)
            const miraklBase = miraklTitle.split(' - ')[0].toLowerCase().trim();
            const shopifyBase = shopifyInfo.productTitle.split(' - ')[0].toLowerCase().trim();
            if (miraklBase !== shopifyBase) {
              issues.push(`TITLE_MISMATCH: mirakl="${miraklTitle}" shopify="${shopifyInfo.productTitle}"`);
            }
          }

          if (issues.length > 0) {
            mismatches.push({
              shop_sku: shopSku,
              mirakl_product_sku: miraklProductSku,
              mirakl_product_title: miraklTitle,
              mirakl_price: miraklPrice,
              shopify_barcode: shopifyInfo.barcode,
              shopify_product_title: shopifyInfo.productTitle,
              shopify_price: shopifyInfo.price,
              issue: issues.join(' | '),
            });
          }
        }
      }

      // Store results in DB for reference
      await query(
        `INSERT INTO sync_state (key, value) VALUES ('last_linkage_audit', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [JSON.stringify({
          at: new Date().toISOString(),
          totalChecked,
          mismatchCount: mismatches.length,
        })]
      );

      logger.info('[audit-linkage] Audit complete', { totalChecked, mismatches: mismatches.length });

      res.json({
        status: 'ok',
        totalChecked,
        mismatchCount: mismatches.length,
        mismatches: mismatches.slice(0, 200), // Cap response size
      });
    } catch (err) {
      logger.error('[audit-linkage] Audit failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Audit failed', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Admin: Pause/resume price corrections ──────────────────────────────────
  app.post('/admin/pause-corrections', express.json(), async (req, res) => {
    const paused = req.body?.paused ?? true;
    await query(
      `INSERT INTO sync_state (key, value) VALUES ('corrections_paused', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify({ paused, at: new Date().toISOString() })]
    );
    logger.info(`[admin] Corrections ${paused ? 'PAUSED' : 'RESUMED'}`);
    res.json({ status: 'ok', paused });
  });

  // ── Admin: Fix mislinked offers (delete + recreate) ─────────────────────────
  // Mirakl won't re-link existing offers to different products via OF01.
  // This endpoint deletes mislinked offers then recreates them correctly.
  app.post('/admin/fix-linkage', express.json(), async (_req, res) => {
    try {
      logger.info('[fix-linkage] Starting mislinked offer fix');

      // 1. Get all Shopify variants (SKU → barcode)
      const allProducts = await shopify.fetchAllProducts();
      const shopifyMap = new Map<string, { barcode: string; productTitle: string }>();
      for (const product of allProducts) {
        for (const variant of product.variants) {
          if (variant.sku && variant.barcode) {
            shopifyMap.set(variant.sku, { barcode: variant.barcode, productTitle: product.title });
          }
        }
      }

      // 2. Get all Mirakl offers via OF52
      const miraklOffers = await mirakl.fetchAllOffers();

      // 3. Also need product_sku from OF52 raw data to detect mislinks
      const axios = (mirakl as any).http;
      const exportRes = await axios.post('/api/offers/export/async', {}, { headers: { 'Content-Type': 'application/json' } });
      const trackingId = exportRes.data.tracking_id;
      let downloadUrls: string[] = [];
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const s = await axios.get(`/api/offers/export/async/status/${trackingId}`);
        if (s.data.status === 'COMPLETED') { downloadUrls = s.data.urls ?? []; break; }
        if (s.data.status === 'FAILED') throw new Error('OF52 failed');
        await new Promise(r => setTimeout(r, 5000));
      }

      // Parse OF52 to get shop-sku → product-sku mapping
      const miraklProductSkuMap = new Map<string, string>();
      for (const url of downloadUrls) {
        const csvRes = await axios.get(url, { responseType: 'text' as const });
        const lines = (csvRes.data as string).split(/\r?\n/).filter((l: string) => l.trim());
        if (lines.length < 2) continue;
        const delimiter = lines[0].includes('\t') ? '\t' : ';';
        const headers = lines[0].split(delimiter).map((h: string) => h.replace(/^"|"$/g, '').toLowerCase().trim());
        const skuIdx = headers.indexOf('shop-sku');
        const prodSkuIdx = headers.indexOf('product-sku');
        if (skuIdx < 0 || prodSkuIdx < 0) continue;
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(delimiter).map((c: string) => c.replace(/^"|"$/g, ''));
          if (cols[skuIdx]) miraklProductSkuMap.set(cols[skuIdx], cols[prodSkuIdx] ?? '');
        }
      }

      // 4. Find mislinked offers
      const mislinked: string[] = [];
      for (const [sku, shopify] of shopifyMap) {
        const miraklProdSku = miraklProductSkuMap.get(sku);
        if (!miraklProdSku) continue;
        const expectedProdSku = 'M' + shopify.barcode;
        if (miraklProdSku !== expectedProdSku) {
          mislinked.push(sku);
        }
      }

      logger.info('[fix-linkage] Found mislinked offers', { count: mislinked.length });

      if (mislinked.length === 0) {
        res.json({ status: 'ok', message: 'No mislinked offers found', mislinkedCount: 0 });
        return;
      }

      // 5. Delete mislinked offers (OF01 with update-delete=D)
      const deleteRows = mislinked.map(sku => `${sku}\tD`);
      const deleteCsv = '\uFEFF' + 'offer-sku\tupdate-delete\r\n' + deleteRows.join('\r\n') + '\r\n';
      const FormData = require('form-data');
      const deleteForm = new FormData();
      deleteForm.append('file', Buffer.from(deleteCsv, 'utf8'), { filename: 'delete-mislinked.csv', contentType: 'text/csv' });
      const deleteRes = await axios.post('/api/offers/imports', deleteForm, {
        headers: { ...deleteForm.getHeaders() },
        params: { import_mode: 'NORMAL' },
      });
      const deleteImportId = deleteRes.data.import_id;
      logger.info('[fix-linkage] Delete import accepted', { importId: deleteImportId, count: mislinked.length });

      // Poll until delete completes
      const pollResult = await mirakl.pollUntilDone(deleteImportId, 'offers');
      logger.info('[fix-linkage] Delete result', { linesOk: pollResult.lines_in_success, linesError: pollResult.lines_in_error });

      // 6. Wait a moment then recreate with correct product-id
      await new Promise(r => setTimeout(r, 5000));

      // Build recreate CSV with correct EANs
      const recreateHeader = 'offer-sku\tproduct-id\tproduct-id-type\tprice\tquantity\tstate\tleadtime-to-ship\tupdate-delete';
      const recreateRows: string[] = [];
      for (const sku of mislinked) {
        const shopify = shopifyMap.get(sku);
        const miraklOffer = miraklOffers.find(o => o.sku === sku);
        if (!shopify) continue;
        const price = miraklOffer?.price ?? 0;
        const qty = miraklOffer?.quantity ?? 0;
        recreateRows.push(`${sku}\t${shopify.barcode}\tEAN\t${price.toFixed(2)}\t${qty}\t11\t3\tU`);
      }

      const recreateCsv = '\uFEFF' + recreateHeader + '\r\n' + recreateRows.join('\r\n') + '\r\n';
      const recreateForm = new FormData();
      recreateForm.append('file', Buffer.from(recreateCsv, 'utf8'), { filename: 'recreate-fixed.csv', contentType: 'text/csv' });
      const recreateRes = await axios.post('/api/offers/imports', recreateForm, {
        headers: { ...recreateForm.getHeaders() },
        params: { import_mode: 'NORMAL' },
      });
      const recreateImportId = recreateRes.data.import_id;
      logger.info('[fix-linkage] Recreate import accepted', { importId: recreateImportId, count: recreateRows.length });

      const recreateResult = await mirakl.pollUntilDone(recreateImportId, 'offers');
      logger.info('[fix-linkage] Recreate result', { linesOk: recreateResult.lines_in_success, linesError: recreateResult.lines_in_error });

      res.json({
        status: 'ok',
        mislinkedCount: mislinked.length,
        deleteResult: { linesOk: pollResult.lines_in_success, linesError: pollResult.lines_in_error },
        recreateResult: { linesOk: recreateResult.lines_in_success, linesError: recreateResult.lines_in_error },
      });
    } catch (err) {
      logger.error('[fix-linkage] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Admin: Fix mislinked offers v2 (suffix SKUs) ────────────────────────────
  // Detects mislinked offers, creates new offers with -V2 suffix SKUs linked
  // to correct products. Old offers are left to expire via Mirakl retention.
  app.post('/admin/fix-linkage-v2', express.json(), async (_req, res) => {
    try {
      logger.info('[fix-linkage-v2] Starting');

      // 1. Get Shopify SKU → barcode mapping
      const allProducts = await shopify.fetchAllProducts();
      const shopifyMap = new Map<string, { barcode: string; price: string; productTitle: string }>();
      for (const product of allProducts) {
        for (const variant of product.variants) {
          if (variant.sku && variant.barcode) {
            shopifyMap.set(variant.sku, { barcode: variant.barcode, price: variant.price, productTitle: product.title });
          }
        }
      }

      // 2. Get Mirakl offer→product linkage via OF52
      const axios = (mirakl as any).http;
      const exportRes = await axios.post('/api/offers/export/async', {}, { headers: { 'Content-Type': 'application/json' } });
      const trackingId = exportRes.data.tracking_id;
      let downloadUrls: string[] = [];
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const s = await axios.get(`/api/offers/export/async/status/${trackingId}`);
        if (s.data.status === 'COMPLETED') { downloadUrls = s.data.urls ?? []; break; }
        if (s.data.status === 'FAILED') throw new Error('OF52 failed');
        await new Promise(r => setTimeout(r, 5000));
      }

      // Parse OF52 for shop-sku → product-sku + quantity
      const miraklMap = new Map<string, { productSku: string; quantity: number; price: number }>();
      for (const url of downloadUrls) {
        const csvRes = await axios.get(url, { responseType: 'text' as const });
        const lines = (csvRes.data as string).split(/\r?\n/).filter((l: string) => l.trim());
        if (lines.length < 2) continue;
        const delim = lines[0].includes('\t') ? '\t' : ';';
        const hdrs = lines[0].split(delim).map((h: string) => h.replace(/^"|"$/g, '').toLowerCase().trim());
        const skuI = hdrs.indexOf('shop-sku');
        const psI = hdrs.indexOf('product-sku');
        const qI = hdrs.indexOf('quantity');
        const pI = hdrs.indexOf('price');
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(delim).map((c: string) => c.replace(/^"|"$/g, ''));
          if (cols[skuI]) miraklMap.set(cols[skuI], {
            productSku: cols[psI] ?? '',
            quantity: qI >= 0 ? parseInt(cols[qI] ?? '0', 10) : 0,
            price: pI >= 0 ? parseFloat(cols[pI] ?? '0') : 0,
          });
        }
      }

      // 3. Find mislinked offers
      const mislinked: Array<{ shopifySku: string; miraklProductSku: string; price: string }> = [];
      for (const [sku, shopify] of shopifyMap) {
        const mk = miraklMap.get(sku);
        if (!mk) continue;
        if (mk.productSku !== 'M' + shopify.barcode) {
          // Use the existing Mirakl product-sku (old EAN) as the product-id for the new offer
          // The product entry in Mirakl is keyed by the operator-assigned product-sku, not our barcode
          mislinked.push({ shopifySku: sku, miraklProductSku: mk.productSku, price: shopify.price });
        }
      }

      logger.info('[fix-linkage-v2] Mislinked offers found', { count: mislinked.length });

      if (mislinked.length === 0) {
        res.json({ status: 'ok', message: 'No mislinked offers', count: 0 });
        return;
      }

      // 4. Insert into sku_remap table
      const suffix = '-V2';
      let inserted = 0;
      for (const m of mislinked) {
        try {
          await query(
            `INSERT INTO sku_remap (shopify_sku, mirakl_sku, suffix, reason)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (shopify_sku) DO NOTHING`,
            [m.shopifySku, m.shopifySku + suffix, suffix, 'EAN mismatch fix 2026-04-01']
          );
          inserted++;
        } catch { /* skip duplicates */ }
      }

      // 5. Create new offers with suffixed SKUs via OF01
      const FormData = require('form-data');
      const header = 'sku\tproduct-id\tproduct-id-type\tprice\tquantity\tstate\tleadtime-to-ship\tupdate-delete';
      const rows: string[] = [];
      for (const m of mislinked) {
        const newSku = m.shopifySku + suffix;
        const mOffer = miraklMap.get(m.shopifySku);
        const qty = mOffer?.quantity ?? 0;
        // Use Mirakl's existing product-sku (old EAN) to link to the correct product entry
        const miraklEan = m.miraklProductSku.replace(/^M/, '');
        rows.push(`${newSku}\t${miraklEan}\tEAN\t${m.price}\t${qty}\t11\t3\tU`);
      }

      const csv = '\uFEFF' + header + '\r\n' + rows.join('\r\n') + '\r\n';
      const form = new FormData();
      form.append('file', Buffer.from(csv, 'utf8'), { filename: 'create-suffixed.csv', contentType: 'text/csv' });
      const createRes = await axios.post('/api/offers/imports', form, {
        headers: { ...form.getHeaders() },
        params: { import_mode: 'NORMAL' },
      });
      const createImportId = createRes.data.import_id;
      logger.info('[fix-linkage-v2] Create import accepted', { importId: createImportId });

      const result = await mirakl.pollUntilDone(createImportId, 'offers');

      // 6. Mark successfully created in sku_remap
      if (result.lines_in_success > 0) {
        await query(`UPDATE sku_remap SET new_offer_created = TRUE, updated_at = NOW() WHERE suffix = $1`, [suffix]);
      }

      // 7. Refresh the in-memory cache
      const { loadRemapCache } = await import('./utils/skuRemap');
      await loadRemapCache();

      logger.info('[fix-linkage-v2] Complete', {
        mislinked: mislinked.length,
        inserted,
        linesOk: result.lines_in_success,
        linesError: result.lines_in_error,
      });

      res.json({
        status: 'ok',
        mislinked: mislinked.length,
        remapInserted: inserted,
        createResult: { linesOk: result.lines_in_success, linesError: result.lines_in_error },
      });
    } catch (err) {
      logger.error('[fix-linkage-v2] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Admin: Trigger full resync (PA01 + OF01) on Railway ─────────────────────
  app.post('/admin/trigger-reconcile', express.json(), async (_req, res) => {
    try {
      const { enqueueJob } = await import('./queue/enqueue');
      const existing = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM jobs WHERE job_type = 'stock_reconcile' AND status IN ('pending', 'running')`
      );
      if (parseInt(existing.rows[0]?.count ?? '0', 10) > 0) {
        res.json({ status: 'already_pending', message: 'A stock_reconcile job is already queued or running' });
        return;
      }
      await enqueueJob('stock_reconcile', {});
      logger.info('[admin] stock_reconcile job enqueued');
      res.json({ status: 'ok', message: 'stock_reconcile job enqueued — will delist non-qualifying offers' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to enqueue', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/admin/trigger-resync', express.json(), async (_req, res) => {
    try {
      // Enqueue a batch_sync job for the worker to process
      const { enqueueJob } = await import('./queue/enqueue');
      // Check no batch_sync already pending
      const existing = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM jobs WHERE job_type = 'batch_sync' AND status IN ('pending', 'running')`
      );
      if (parseInt(existing.rows[0]?.count ?? '0', 10) > 0) {
        res.json({ status: 'already_pending', message: 'A batch_sync job is already queued or running' });
        return;
      }
      await enqueueJob('batch_sync', {});
      logger.info('[admin] batch_sync job enqueued');
      res.json({ status: 'ok', message: 'batch_sync job enqueued — worker will process PA01 then OF01' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to enqueue', detail: err instanceof Error ? err.message : String(err) });
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
    logger.info('  GET  /admin/audit-linkage          — Audit offer→product linkage');
    logger.info('  POST /admin/pause-corrections      — Pause/resume stock/price corrections');
    logger.info('  POST /webhooks/shopify/inventory   — Shopify stock changes → Mirakl OF01');
    logger.info('  POST /webhooks/mirakl/orders       — Mirakl sale → Shopify order');
    logger.info('  POST /webhooks/shopify/fulfilment  — Shopify fulfilment → Mirakl OR23+OR24');
    logger.info('  POST /webhooks/shopify/refund      — Shopify refund → Mirakl OR28');
  });
}
