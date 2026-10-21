import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, loadMappingConfig } from '../../config';
import { ShopifyClient } from '../../shopifyClient';
import { MiraklClient } from '../../miraklClient';
import { loadTemplates } from '../../templates/templateReader';
import { mapOfferToRows } from '../../mappers/offerMapper';
import { normaliseHeaderKey } from '../../mappers/productMapper';
import { writeCsv } from '../../exporters/csvExporter';
import { MiraklRow } from '../../types';
import { query } from '../../db/pool';
import { toMiraklSku } from '../../utils/skuRemap';
import { logger } from '../../logger';

/**
 * One-shot recovery: re-create Mirakl offers that were DELETED on the Mirakl
 * side (product still Published, no offer). Built for 3-8 Sep 2026 when ~315
 * in-stock SKUs dropped out of the OF52 export without the connector delisting
 * them.
 *
 * Why not restore_delisted: stock_update / reconcile / restore_delisted send
 * minimal OF01 rows (offer-sku, quantity, price, update-delete) which only
 * update an EXISTING offer — Mirakl rejects them for a deleted offer. This job
 * sends FULL offer rows (product-id/EAN, state, leadtime, price, discount-price,
 * quantity) via the same mapper batch_sync uses, which creates the offer.
 *
 * Candidates: stock_ledger rows with mirakl_qty > 0 whose last_verified_at
 * falls inside [lostSince, lostUntil] (i.e. last seen in the export then) and
 * that are absent from the current OF52 export.
 *
 * Payload: { lostSince: ISO, lostUntil: ISO, dryRun?: boolean }
 *
 * Only relists variants that are, right now: active + debenhams-tagged
 * (fetchAllProducts filter), ON SALE (compareAtPrice > price — Debenhams is a
 * markdown-only channel), and in stock after the buffer.
 */
export async function handleRelistOffers(payload: Record<string, unknown>): Promise<void> {
  const lostSince = String(payload.lostSince ?? '');
  const lostUntil = String(payload.lostUntil ?? '');
  const dryRun = Boolean(payload.dryRun);
  if (!lostSince || !lostUntil) throw new Error('relist_offers requires lostSince/lostUntil');

  const config = loadConfig();
  const mapping = loadMappingConfig();
  const shopify = new ShopifyClient(config);
  const mirakl = new MiraklClient(config);

  const ledger = await query<{ sku: string }>(
    `SELECT sku FROM stock_ledger
      WHERE mirakl_qty > 0 AND last_verified_at BETWEEN $1 AND $2`,
    [lostSince, lostUntil]
  );
  const candidates = new Set(ledger.rows.map(r => r.sku));
  logger.info('[relist_offers] Candidate SKUs from ledger', { count: candidates.size, lostSince, lostUntil, dryRun });
  if (candidates.size === 0) return;

  // Never touch an offer that is live right now.
  const liveOffers = await mirakl.fetchAllOffers();
  const liveSkus = new Set(liveOffers.map(o => o.sku));
  let stillLive = 0;
  for (const sku of [...candidates]) {
    if (liveSkus.has(toMiraklSku(sku)) || liveSkus.has(sku)) { candidates.delete(sku); stillLive++; }
  }

  // Same template header resolution as batch_sync.
  const templatesPath = process.env.TEMPLATES_PATH ?? config.paths.templates;
  const templates = await loadTemplates(templatesPath);
  const outputHeaders = templates.combined?.headers ?? templates.products?.headers ?? [];
  const skuIdx = outputHeaders.findIndex(h => h.toLowerCase() === 'sku');
  const offerHeaders = skuIdx > 0 ? outputHeaders.slice(skuIdx) : (templates.offers?.headers ?? []);
  if (offerHeaders.length === 0) throw new Error('[relist_offers] no offer template headers');

  const keyOf = (norm: string) => offerHeaders.find(h => normaliseHeaderKey(h) === norm);
  const skuKey = keyOf('sku');
  const qtyKey = keyOf('quantity');
  const priceKey = keyOf('price');
  const discountKey = keyOf('discount-price');
  if (!skuKey || !qtyKey || !priceKey) throw new Error('[relist_offers] template lacks sku/quantity/price');

  // fetchAllProducts = status:active AND tag:debenhams
  const products = await shopify.fetchAllProducts();
  const rows: MiraklRow[] = [];
  const plan: Array<{ sku: string; title: string; quantity: number; price: string; discountPrice: string }> = [];
  const seen = new Set<string>();
  let notOnSale = 0;
  let zeroAfterBuffer = 0;

  for (const product of products) {
    if (!product.variants.some(v => v.sku && candidates.has(v.sku))) continue;
    const productRows = mapOfferToRows(product, offerHeaders, mapping, false);
    for (const variant of product.variants) {
      if (!variant.sku || !candidates.has(variant.sku)) continue;
      seen.add(variant.sku);
      const compare = parseFloat(variant.compareAtPrice || '0');
      const current = parseFloat(variant.price || '0');
      if (!(compare > current)) { notOnSale++; continue; }
      const row = productRows.find(r => String(r[skuKey] ?? '') === toMiraklSku(variant.sku));
      if (!row) continue;
      if (Number(row[qtyKey] ?? 0) <= 0) { zeroAfterBuffer++; continue; }
      rows.push(row);
      plan.push({
        sku: variant.sku,
        title: product.title,
        quantity: Number(row[qtyKey]),
        price: String(row[priceKey] ?? ''),
        discountPrice: discountKey ? String(row[discountKey] ?? '') : '',
      });
    }
  }
  const notQualifying = [...candidates].filter(s => !seen.has(s)).length;

  const summary: Record<string, unknown> = {
    at: new Date().toISOString(),
    lostSince, lostUntil, dryRun,
    ledgerCandidates: ledger.rows.length,
    stillLive,
    notQualifying,
    notOnSale,
    zeroAfterBuffer,
    toRelist: plan.length,
    units: plan.reduce((n, p) => n + p.quantity, 0),
    plan,
  };
  logger.info('[relist_offers] Plan', { ...summary, plan: plan.slice(0, 5) });

  if (!dryRun && rows.length > 0) {
    const tmpDir = path.join(os.tmpdir(), 'mirakl-relist-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const csvPath = writeCsv(offerHeaders, rows, { outputDir: tmpDir, filename: 'offers-relist', delimiter: ';' });
      const importId = await mirakl.uploadOffersFile(csvPath);
      const result = await mirakl.pollUntilDone(importId, 'offers');
      summary.importId = importId;
      summary.linesOk = result.lines_in_success ?? 0;
      summary.linesError = result.lines_in_error ?? 0;
      logger.info('[relist_offers] OF01 complete', { importId, linesOk: summary.linesOk, linesError: summary.linesError });
      for (const p of plan) {
        await query(`UPDATE stock_ledger SET last_pushed_at = NOW() WHERE sku = $1`, [p.sku]);
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  await query(
    `INSERT INTO sync_state (key, value) VALUES ('last_relist_offers', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(summary)]
  );
  await query(
    `INSERT INTO alerts (severity, category, message, metadata) VALUES ('info', 'relist_offers', $1, $2)`,
    [
      `Relist offers: ${dryRun ? 'DRY RUN ' : ''}${plan.length} offers${dryRun ? ' planned' : ` sent (ok ${summary.linesOk}, errors ${summary.linesError})`}`,
      JSON.stringify({ ...summary, plan: plan.slice(0, 20) }),
    ]
  );
}
