/**
 * Surgical PA01 re-submission for the "broken Debenhams listings" set.
 *
 * Computes: Louche variants where product.status=ACTIVE, variant has a numeric
 * SKU, product carries both the `debenhams` tag and a sale-indicating tag, AND
 * the SKU is NOT currently in Mirakl's live offer set. These are products the
 * operator has flagged for Debenhams listing (per markdown-only policy) but
 * which Mirakl rejects on stock_update with "state unknown" — most likely
 * because PA01 acceptance never completed or lapsed.
 *
 * Enqueues a `batch_sync` job with `payload.skuFilter = [...SKUs]`. That handler
 * re-uses the existing PA01 upload + OF01 handoff via `check_import`, which
 * means no new Mirakl integration code needed — just a targeted trigger.
 *
 *   railway ssh -s worker "node /app/dist/index.js admin bulk-resubmit-broken-listings --dry-run"
 *   railway ssh -s worker "node /app/dist/index.js admin bulk-resubmit-broken-listings"
 */

import { loadConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { MiraklClient } from '../miraklClient';
import { query } from '../db/pool';
import { enqueueJob } from '../queue/enqueue';

const NUMERIC_SKU_RE = /^[0-9]{5,12}$/;
const SALE_TAG_RE = /^(womenswear sale|further reduction|sale|last-chance|markdown|clearance|outlet)$/i;

interface VariantNode {
  id: string;
  sku: string | null;
  product: { id: string; title: string; handle: string; status: string; tags: string[] };
}
interface R {
  data?: {
    productVariants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: VariantNode }>;
    };
  };
}

export async function bulkResubmitBrokenListings(opts: { dryRun: boolean; limit?: number }): Promise<void> {
  const config = loadConfig();
  const shopify = new ShopifyClient(config);
  const mirakl = new MiraklClient(config);

  process.stderr.write('Fetching Mirakl offers (OF52)…\n');
  const offers = await mirakl.fetchAllOffers();
  const liveMiraklSkus = new Set(offers.filter(o => o.sku).map(o => o.sku));

  process.stderr.write('Fetching Louche variants + filtering to broken-listing set…\n');
  const QUERY = `
    query V($cursor: String) {
      productVariants(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            sku
            product { id title handle status tags }
          }
        }
      }
    }
  `;
  const broken: Array<{ sku: string; productTitle: string; productHandle: string }> = [];
  let cursor: string | null = null;
  const gql = shopify as unknown as { gql: <T>(q: string, v: Record<string, unknown>) => Promise<T> };
  do {
    const r: R = await gql.gql<R>(QUERY, { cursor });
    const vs = r.data?.productVariants;
    if (!vs) break;
    for (const edge of vs.edges) {
      const v = edge.node;
      const sku = v.sku ?? '';
      if (v.product.status !== 'ACTIVE') continue;
      if (!NUMERIC_SKU_RE.test(sku)) continue;
      if (liveMiraklSkus.has(sku)) continue;
      const tagsLower = (v.product.tags ?? []).map(t => t.toLowerCase());
      if (!tagsLower.includes('debenhams')) continue;
      if (!tagsLower.some(t => SALE_TAG_RE.test(t))) continue;
      broken.push({ sku, productTitle: v.product.title, productHandle: v.product.handle });
    }
    cursor = vs.pageInfo.hasNextPage ? vs.pageInfo.endCursor : null;
  } while (cursor);

  // Pick subset when --limit <n> provided. Sort products by handle (deterministic
  // across runs) and take the first n product handles, then keep only variants
  // whose product handle is in that set. This gives a stable canary — re-running
  // the command picks the SAME 20 products every time, so retries are idempotent.
  const allProductHandles = [...new Set(broken.map(b => b.productHandle))].sort();
  const selectedHandles = opts.limit && opts.limit > 0
    ? new Set(allProductHandles.slice(0, opts.limit))
    : new Set(allProductHandles);
  const filteredBroken = broken.filter(b => selectedHandles.has(b.productHandle));

  const uniqueSkus = [...new Set(filteredBroken.map(b => b.sku))];
  const uniqueProducts = new Set(filteredBroken.map(b => b.productHandle)).size;
  const allUniqueProducts = allProductHandles.length;

  process.stdout.write('=== BULK RESUBMIT — BROKEN LISTINGS ===\n');
  process.stdout.write(`mirakl_live_offers=${liveMiraklSkus.size}\n`);
  process.stdout.write(`total_broken_variants=${broken.length}\n`);
  process.stdout.write(`total_unique_products=${allUniqueProducts}\n`);
  if (opts.limit && opts.limit > 0) {
    process.stdout.write(`limit=${opts.limit}  (canary mode; alphabetical by product handle)\n`);
  }
  process.stdout.write(`selected_variants=${filteredBroken.length}\n`);
  process.stdout.write(`selected_unique_skus=${uniqueSkus.length}\n`);
  process.stdout.write(`selected_unique_products=${uniqueProducts}\n`);

  if (filteredBroken.length === 0) {
    process.stdout.write('\nNo broken listings in selected set — nothing to re-submit.\n');
    return;
  }

  // Sample preview — when canary-limited, show all selected products for confidence
  const sampleSize = opts.limit && opts.limit > 0 ? filteredBroken.length : 10;
  process.stdout.write(`\nSample (first ${Math.min(sampleSize, filteredBroken.length)} variants):\n`);
  for (const b of filteredBroken.slice(0, sampleSize)) {
    process.stdout.write(`  ${b.sku}\t${b.productTitle}\t/${b.productHandle}\n`);
  }

  if (opts.dryRun) {
    process.stdout.write('\nDRY RUN — no job enqueued. Re-run without --dry-run to submit PA01.\n');
    return;
  }

  // Enqueue batch_sync with skuFilter
  process.stderr.write('\nEnqueuing batch_sync job with skuFilter…\n');
  const job = await enqueueJob('batch_sync', { skuFilter: uniqueSkus });
  const jobId = job.id;
  process.stdout.write(`\n=== JOB ENQUEUED ===\n`);
  process.stdout.write(`batch_sync_job_id=${jobId}\n`);

  // Record in sync_state for audit
  await query(
    `INSERT INTO sync_state (key, value) VALUES ('last_bulk_resubmit', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify({
      at: new Date().toISOString(),
      jobId,
      limit: opts.limit ?? null,
      totalBrokenVariants: broken.length,
      selectedVariants: filteredBroken.length,
      selectedUniqueSkus: uniqueSkus.length,
      selectedUniqueProducts: uniqueProducts,
    })]
  );

  process.stdout.write('\nNext: the worker will fetch Shopify products, filter to these SKUs, upload PA01, and\n');
  process.stdout.write('store the offers CSV. The check_import recurring job (every 5 min) will poll PA01 status\n');
  process.stdout.write('and upload OF01 once products are accepted. Monitor via: admin queue-status\n');
}
