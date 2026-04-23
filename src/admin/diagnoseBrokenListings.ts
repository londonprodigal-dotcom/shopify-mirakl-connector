/**
 * Diagnostic: classify why the "broken Debenhams listings" are broken.
 *
 * Takes the set of Louche variants that:
 *   - are active on Shopify
 *   - carry the `debenhams` tag
 *   - carry a sale-indicating tag (this matches the markdown-channel policy)
 *   - have a numeric SKU (/^[0-9]{5,12}$/)
 *   - are NOT currently in Mirakl's live offer set
 *
 * Cross-references each with Mirakl's CM11 product-status feed (~2000 products
 * for Louche, ~40s runtime with pagination). Reports:
 *   - How many are present in CM11 at all (if missing → never submitted via PA01)
 *   - Of those present: LIVE vs NOT_LIVE breakdown
 *   - Top rejection messages for the NOT_LIVE subset
 *   - A sample of 10 representative SKUs with full detail
 *
 * This tells us whether the 703 broken set is a submission problem (fix: trigger
 * PA01), an acceptance problem (fix: address the rejection reason), or a
 * delisting problem (fix: relist).
 */

import { loadConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { MiraklClient } from '../miraklClient';

const NUMERIC_SKU_RE = /^[0-9]{5,12}$/;
const SALE_TAG_RE = /^(womenswear sale|further reduction|sale|last-chance|markdown|clearance|outlet)$/i;

interface VariantNode {
  id: string;
  sku: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
  product: { id: string; title: string; handle: string; status: string; tags: string[] };
}
interface VariantQueryResponse {
  data?: {
    productVariants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: VariantNode }>;
    };
  };
}

interface BrokenVariant {
  variantId: string;
  sku: string;
  productTitle: string;
  productHandle: string;
}

async function fetchBrokenListings(shopify: ShopifyClient, miraklSkus: Set<string>): Promise<BrokenVariant[]> {
  const QUERY = `
    query V($cursor: String) {
      productVariants(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            sku
            selectedOptions { name value }
            product { id title handle status tags }
          }
        }
      }
    }
  `;
  const broken: BrokenVariant[] = [];
  let cursor: string | null = null;
  const gql = shopify as unknown as { gql: <T>(q: string, v: Record<string, unknown>) => Promise<T> };
  do {
    const r: VariantQueryResponse = await gql.gql<VariantQueryResponse>(QUERY, { cursor });
    const vs = r.data?.productVariants;
    if (!vs) break;
    for (const edge of vs.edges) {
      const v = edge.node;
      const sku = v.sku ?? '';
      if (v.product.status !== 'ACTIVE') continue;
      if (!NUMERIC_SKU_RE.test(sku)) continue;
      if (miraklSkus.has(sku)) continue;
      const tagsLower = (v.product.tags ?? []).map(t => t.toLowerCase());
      if (!tagsLower.includes('debenhams')) continue;
      if (!tagsLower.some(t => SALE_TAG_RE.test(t))) continue;
      broken.push({
        variantId: v.id,
        sku,
        productTitle: v.product.title,
        productHandle: v.product.handle,
      });
    }
    cursor = vs.pageInfo.hasNextPage ? vs.pageInfo.endCursor : null;
  } while (cursor);
  return broken;
}

export async function diagnoseBrokenListings(): Promise<void> {
  const config = loadConfig();
  const shopify = new ShopifyClient(config);
  const mirakl = new MiraklClient(config);

  process.stderr.write('Step 1: Fetching Mirakl offers (OF52)…\n');
  const offers = await mirakl.fetchAllOffers();
  const miraklSkus = new Set(offers.filter(o => o.sku).map(o => o.sku));
  process.stderr.write(`  → ${miraklSkus.size} live offers on Mirakl\n`);

  process.stderr.write('Step 2: Fetching Louche variants + filtering to broken-listing set…\n');
  const broken = await fetchBrokenListings(shopify, miraklSkus);
  process.stderr.write(`  → ${broken.length} broken listings (numeric SKU, active, debenhams-tagged, sale-tagged, not on Mirakl)\n`);

  if (broken.length === 0) {
    process.stdout.write('No broken listings to diagnose.\n');
    return;
  }

  process.stderr.write('Step 3: Fetching CM11 product statuses (paginated, ~40s)…\n');
  const cm11 = await mirakl.fetchProductStatuses();
  process.stderr.write(`  → ${cm11.live + cm11.notLive} products in CM11 feed (${cm11.live} LIVE, ${cm11.notLive} NOT_LIVE)\n`);

  // Index CM11 by SKU
  const cm11BySku = new Map<string, { status: string; error?: string }>();
  for (const p of cm11.products) {
    if (p.sku) cm11BySku.set(p.sku, { status: p.status, error: p.error });
  }

  // Classify each broken variant
  type Classification = 'not_in_cm11' | 'cm11_live' | 'cm11_not_live';
  const classified: Array<BrokenVariant & { classification: Classification; cm11Status?: string; cm11Error?: string }> = [];
  const counts: Record<Classification, number> = { not_in_cm11: 0, cm11_live: 0, cm11_not_live: 0 };
  const errorCounts: Record<string, number> = {};

  for (const v of broken) {
    const cm11Entry = cm11BySku.get(v.sku);
    let classification: Classification;
    if (!cm11Entry) {
      classification = 'not_in_cm11';
    } else if (cm11Entry.status === 'LIVE') {
      classification = 'cm11_live';
    } else {
      classification = 'cm11_not_live';
      if (cm11Entry.error) {
        const key = cm11Entry.error.substring(0, 100);
        errorCounts[key] = (errorCounts[key] ?? 0) + 1;
      }
    }
    counts[classification]++;
    classified.push({ ...v, classification, cm11Status: cm11Entry?.status, cm11Error: cm11Entry?.error });
  }

  process.stdout.write('=== BROKEN LISTINGS DIAGNOSIS ===\n');
  process.stdout.write(`total_broken=${broken.length}\n`);
  process.stdout.write('\nClassification:\n');
  process.stdout.write(`  not_in_cm11=${counts.not_in_cm11}          (never submitted via PA01 → fix: trigger batch PA01)\n`);
  process.stdout.write(`  cm11_live=${counts.cm11_live}             (product LIVE on Mirakl but no offer → fix: push OF01)\n`);
  process.stdout.write(`  cm11_not_live=${counts.cm11_not_live}         (product REJECTED by Mirakl → fix: address rejection)\n`);

  if (Object.keys(errorCounts).length > 0) {
    process.stdout.write('\nTop rejection reasons (cm11_not_live subset):\n');
    const sorted = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [err, n] of sorted) {
      process.stdout.write(`  [${n}] ${err}\n`);
    }
  }

  // Sample of 10 per classification
  process.stdout.write('\n=== SAMPLE (up to 10 per bucket) ===\n');
  for (const cls of ['not_in_cm11', 'cm11_live', 'cm11_not_live'] as const) {
    const subset = classified.filter(c => c.classification === cls).slice(0, 10);
    if (subset.length === 0) continue;
    process.stdout.write(`\n--- ${cls} (sample ${subset.length}) ---\n`);
    for (const v of subset) {
      process.stdout.write(`  ${v.sku}  ${v.productTitle}  /${v.productHandle}  ${v.cm11Status ?? '(absent)'}  ${(v.cm11Error ?? '').substring(0, 120)}\n`);
    }
  }
}
