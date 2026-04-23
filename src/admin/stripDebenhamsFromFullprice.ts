/**
 * One-off: strip the `debenhams` tag from active Louche products that are
 * currently full-price. Part of the markdown-only policy cleanup.
 *
 * Criteria for "full-price" (BOTH must hold — conservative):
 *   1. No variant has compareAtPrice > price (not marked down)
 *   2. Product has no sale-indicating tag (womenswear sale, sale, further
 *      reduction, last-chance, markdown, clearance, outlet)
 *
 * After the tag is stripped, the next `stock_reconcile` run will see the
 * product is no longer in `fetchQualifyingSkus` (which filters
 * status:active AND tag:debenhams) and auto-delist the Mirakl offer via
 * the existing non-qualifying-offers block.
 *
 *   railway ssh -s worker "node /app/dist/index.js admin strip-debenhams-from-fullprice --dry-run"
 *   railway ssh -s worker "node /app/dist/index.js admin strip-debenhams-from-fullprice --execute"
 *   railway ssh -s worker "node /app/dist/index.js admin strip-debenhams-from-fullprice --execute --trigger-reconcile"
 */

import { loadConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { enqueueJob } from '../queue/enqueue';

const SALE_TAG_RE = /^(womenswear sale|further reduction|sale|last-chance|markdown|clearance|outlet)$/i;

interface VariantNode {
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
}
interface ProductNode {
  id: string;
  title: string;
  handle: string;
  tags: string[];
  variants: { edges: Array<{ node: VariantNode }> };
}
interface ProductListResponse {
  data?: {
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: ProductNode }>;
    };
  };
}

async function fetchDebenhamsActiveWithVariants(shopify: ShopifyClient): Promise<ProductNode[]> {
  const gql = shopify as unknown as { gql: <T>(q: string, v: Record<string, unknown>) => Promise<T> };
  const QUERY = `
    query($cursor: String) {
      products(first: 100, after: $cursor, query: "status:active AND tag:debenhams") {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            tags
            variants(first: 100) {
              edges { node { sku price compareAtPrice } }
            }
          }
        }
      }
    }
  `;
  const out: ProductNode[] = [];
  let cursor: string | null = null;
  do {
    const r: ProductListResponse = await gql.gql<ProductListResponse>(QUERY, { cursor });
    const ps = r.data?.products;
    if (!ps) break;
    for (const e of ps.edges) out.push(e.node);
    cursor = ps.pageInfo.hasNextPage ? ps.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

function isFullPrice(p: ProductNode): boolean {
  const anyOnSale = p.variants.edges.some(v => {
    const compare = parseFloat(v.node.compareAtPrice ?? '0');
    const current = parseFloat(v.node.price);
    return compare > current;
  });
  if (anyOnSale) return false;
  const hasSaleTag = (p.tags ?? []).some(t => SALE_TAG_RE.test(t.trim()));
  if (hasSaleTag) return false;
  return true;
}

async function removeTagBatch(shopify: ShopifyClient, productIds: string[]): Promise<{ ok: number; errors: Array<{ id: string; message: string }> }> {
  if (productIds.length === 0) return { ok: 0, errors: [] };
  const gql = shopify as unknown as { gql: <T>(q: string, v: Record<string, unknown>) => Promise<T> };
  // Build aliased mutation: one tagsRemove per id, all in a single request
  const aliases = productIds.map((_id, i) => `r${i}`);
  const args = productIds.map((_id, i) => `$id${i}: ID!, $tags${i}: [String!]!`).join(', ');
  const body = productIds.map((_id, i) => `${aliases[i]}: tagsRemove(id: $id${i}, tags: $tags${i}) { userErrors { field message } }`).join('\n    ');
  const mutation = `mutation BatchRemove(${args}) {\n    ${body}\n  }`;
  const variables: Record<string, unknown> = {};
  productIds.forEach((id, i) => {
    variables[`id${i}`] = id;
    variables[`tags${i}`] = ['debenhams'];
  });
  type BatchResp = {
    data?: Record<string, { userErrors?: Array<{ field: string[]; message: string }> }>;
    errors?: Array<{ message: string }>;
  };
  const r: BatchResp = await gql.gql<BatchResp>(mutation, variables);
  const errors: Array<{ id: string; message: string }> = [];
  let ok = 0;
  productIds.forEach((id, i) => {
    const entry = r.data?.[aliases[i]];
    const ue = entry?.userErrors ?? [];
    if (ue.length > 0) errors.push({ id, message: ue.map(e => e.message).join('; ') });
    else ok++;
  });
  if (r.errors && r.errors.length > 0) {
    for (const e of r.errors) errors.push({ id: '(top-level)', message: e.message });
  }
  return { ok, errors };
}

export async function stripDebenhamsFromFullprice(opts: { dryRun: boolean; triggerReconcile?: boolean }): Promise<void> {
  const config = loadConfig();
  const shopify = new ShopifyClient(config);

  process.stderr.write('Fetching Louche active+debenhams-tagged products with variant pricing…\n');
  const products = await fetchDebenhamsActiveWithVariants(shopify);
  process.stderr.write(`  → ${products.length} debenhams-tagged active products\n`);

  const targets = products.filter(isFullPrice);
  process.stdout.write('=== STRIP DEBENHAMS TAG FROM FULL-PRICE ===\n');
  process.stdout.write(`debenhams_tagged_active=${products.length}\n`);
  process.stdout.write(`target_full_price=${targets.length}\n`);
  process.stdout.write(`keeping_on_sale_or_sale_tagged=${products.length - targets.length}\n`);

  if (targets.length === 0) {
    process.stdout.write('\nNo full-price debenhams-tagged products — nothing to do.\n');
    return;
  }

  process.stdout.write('\nSample (first 15 targets):\n');
  for (const p of targets.slice(0, 15)) {
    process.stdout.write(`  ${p.handle}\t${p.title}\n`);
  }

  if (opts.dryRun) {
    process.stdout.write('\nDRY RUN — no tags stripped. Re-run with --execute to apply.\n');
    return;
  }

  // Execute: strip `debenhams` tag via aliased tagsRemove. Chunks of 25 per
  // request keep the GraphQL cost inside Shopify's bucket; small pause between
  // chunks is cheap insurance against burst limits.
  const CHUNK = 25;
  let totalOk = 0;
  const allErrors: Array<{ id: string; message: string }> = [];
  for (let i = 0; i < targets.length; i += CHUNK) {
    const batch = targets.slice(i, i + CHUNK).map(p => p.id);
    process.stderr.write(`Chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(targets.length / CHUNK)}: removing 'debenhams' from ${batch.length} products…\n`);
    try {
      const res = await removeTagBatch(shopify, batch);
      totalOk += res.ok;
      allErrors.push(...res.errors);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      allErrors.push({ id: `chunk@${i}`, message: msg });
    }
    await new Promise(r => setTimeout(r, 600));
  }

  process.stdout.write(`\n=== RESULT ===\n`);
  process.stdout.write(`ok=${totalOk}\n`);
  process.stdout.write(`errors=${allErrors.length}\n`);
  if (allErrors.length > 0) {
    process.stdout.write('\nErrors (first 10):\n');
    for (const e of allErrors.slice(0, 10)) {
      process.stdout.write(`  ${e.id}: ${e.message}\n`);
    }
  }

  if (opts.triggerReconcile) {
    process.stderr.write('\nEnqueuing stock_reconcile so Mirakl auto-delists the non-qualifying offers…\n');
    const job = await enqueueJob('stock_reconcile', {});
    process.stdout.write(`\nstock_reconcile_job_id=${job.id}\n`);
    process.stdout.write('On the next hourly cycle (or when this job runs), Mirakl offers for the\n');
    process.stdout.write('untagged products get qty=0 pushed → delisted from Debenhams PDPs.\n');
  } else {
    process.stdout.write('\nNext step: enqueue stock_reconcile to delist from Mirakl, or wait for the\n');
    process.stdout.write('next hourly cycle. Pass --trigger-reconcile on this command to do it automatically.\n');
  }
}
