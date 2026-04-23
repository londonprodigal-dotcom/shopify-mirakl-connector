/**
 * Cross-check: which of the Louche variants with legacy numeric SKUs are
 * currently live on Mirakl (selling fine on Debenhams) vs Louche-only
 * (either deliberately Louche-only or broken listings).
 *
 * Shopify side: pulls every active/draft/archived variant, filters to
 *   /^[0-9]{5,12}$/ SKUs, groups by product status.
 * Mirakl side: OF52 async export (rate-limit-free), collects every offer SKU.
 *
 * Emits a summary table and full CSV of the Louche-only bucket (the actionable
 * set — these are the candidates for "broken listing" or "needs PA01").
 *
 * Run inside the Railway container:
 *   railway ssh -s worker "node /app/dist/index.js admin numeric-sku-mirakl-diff"
 */

import { loadConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';
import { MiraklClient } from '../miraklClient';

const NUMERIC_SKU_RE = /^[0-9]{5,12}$/;

interface VariantNode {
  id: string;
  sku: string | null;
  title: string;
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

interface VariantRow {
  variantId: string;
  productId: string;
  productTitle: string;
  productHandle: string;
  productStatus: string;
  productTags: string[];
  sku: string;
  size: string | null;
  hasDebenhamsTag: boolean;
}

async function fetchAllVariants(shopify: ShopifyClient): Promise<VariantRow[]> {
  const QUERY = `
    query V($cursor: String) {
      productVariants(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            sku
            title
            selectedOptions { name value }
            product { id title handle status tags }
          }
        }
      }
    }
  `;
  const rows: VariantRow[] = [];
  let cursor: string | null = null;
  const gql = shopify as unknown as { gql: <T>(q: string, v: Record<string, unknown>) => Promise<T> };
  do {
    const r: VariantQueryResponse = await gql.gql<VariantQueryResponse>(QUERY, { cursor });
    const vs = r.data?.productVariants;
    if (!vs) break;
    for (const edge of vs.edges) {
      const v = edge.node;
      const sizeOpt = v.selectedOptions.find((o: { name: string; value: string }) => /^(size|uk size)$/i.test(o.name));
      const tags = v.product.tags ?? [];
      rows.push({
        variantId: v.id,
        productId: v.product.id,
        productTitle: v.product.title,
        productHandle: v.product.handle,
        productStatus: v.product.status,
        productTags: tags,
        sku: v.sku ?? '',
        size: sizeOpt?.value ?? null,
        hasDebenhamsTag: tags.some(t => t.toLowerCase() === 'debenhams'),
      });
    }
    cursor = vs.pageInfo.hasNextPage ? vs.pageInfo.endCursor : null;
  } while (cursor);
  return rows;
}

export async function numericSkuMiraklDiff(): Promise<void> {
  const config = loadConfig();
  const shopify = new ShopifyClient(config);
  const mirakl = new MiraklClient(config);

  process.stderr.write('Fetching Louche variants…\n');
  const variants = await fetchAllVariants(shopify);
  process.stderr.write(`  → ${variants.length} variants total\n`);

  const numeric = variants.filter(v => NUMERIC_SKU_RE.test(v.sku));
  process.stderr.write(`  → ${numeric.length} with numeric SKUs\n`);

  process.stderr.write('Fetching Mirakl offers (OF52)…\n');
  const miraklOffers = await mirakl.fetchAllOffers();
  const miraklSkus = new Set(miraklOffers.filter(o => o.sku).map(o => o.sku));
  process.stderr.write(`  → ${miraklSkus.size} Mirakl offers\n`);

  // Also compute how many non-numeric SKUs are on Mirakl, to sanity-check
  // (expectation: most Mirakl offers have PRODUCT-SIZE style SKUs, a minority
  // have numeric; we want to know the breakdown).
  const miraklNumericCount = [...miraklSkus].filter(s => NUMERIC_SKU_RE.test(s)).length;

  // Partition numeric-SKU Louche variants by Mirakl membership × product status × debenhams tag
  type Bucket = {
    onMirakl_active: number; onMirakl_archived: number; onMirakl_draft: number;
    louche_only_active: number; louche_only_archived: number; louche_only_draft: number;
    louche_only_active_debenhams_tagged: number;
    louche_only_active_not_tagged: number;
  };
  const bucket: Bucket = {
    onMirakl_active: 0, onMirakl_archived: 0, onMirakl_draft: 0,
    louche_only_active: 0, louche_only_archived: 0, louche_only_draft: 0,
    louche_only_active_debenhams_tagged: 0,
    louche_only_active_not_tagged: 0,
  };

  const louchOnlyActive: VariantRow[] = [];
  for (const v of numeric) {
    const onMirakl = miraklSkus.has(v.sku);
    const status = v.productStatus;
    if (onMirakl) {
      if (status === 'ACTIVE')   bucket.onMirakl_active++;
      else if (status === 'ARCHIVED') bucket.onMirakl_archived++;
      else bucket.onMirakl_draft++;
    } else {
      if (status === 'ACTIVE') {
        bucket.louche_only_active++;
        if (v.hasDebenhamsTag) bucket.louche_only_active_debenhams_tagged++;
        else bucket.louche_only_active_not_tagged++;
        louchOnlyActive.push(v);
      } else if (status === 'ARCHIVED') bucket.louche_only_archived++;
      else bucket.louche_only_draft++;
    }
  }

  // Summary to stdout
  process.stdout.write('=== SUMMARY ===\n');
  process.stdout.write(`louche_variants_total=${variants.length}\n`);
  process.stdout.write(`louche_variants_numeric_sku=${numeric.length}\n`);
  process.stdout.write(`mirakl_offers_total=${miraklSkus.size}\n`);
  process.stdout.write(`mirakl_offers_with_numeric_sku=${miraklNumericCount}\n`);
  process.stdout.write('\n=== NUMERIC-SKU VARIANTS × MIRAKL PRESENCE ===\n');
  process.stdout.write(`on_mirakl_active=${bucket.onMirakl_active}              (syncing fine — leave alone)\n`);
  process.stdout.write(`on_mirakl_archived=${bucket.onMirakl_archived}            (selling as Louche-archived but still on Debenhams — usually fine)\n`);
  process.stdout.write(`on_mirakl_draft=${bucket.onMirakl_draft}\n`);
  process.stdout.write(`louche_only_active=${bucket.louche_only_active}              (active on Louche site, NOT on Mirakl — the actionable set)\n`);
  process.stdout.write(`  └─ with debenhams tag=${bucket.louche_only_active_debenhams_tagged}        (INTENDED to sell on Debenhams → broken listing, real lost revenue)\n`);
  process.stdout.write(`  └─ without debenhams tag=${bucket.louche_only_active_not_tagged}     (deliberately Louche-only → no action needed)\n`);
  process.stdout.write(`louche_only_archived=${bucket.louche_only_archived}           (archived on Louche, not on Mirakl — expected)\n`);
  process.stdout.write(`louche_only_draft=${bucket.louche_only_draft}              (unreleased, cleanup before launch)\n`);

  // CSV of the "Louche-only active" bucket (the actionable set for revenue)
  process.stdout.write('\n=== LOUCHE-ONLY ACTIVE (broken listings + deliberate Louche-only) ===\n');
  process.stdout.write('variant_id,sku,product_title,product_handle,has_debenhams_tag,tags\n');
  for (const v of louchOnlyActive) {
    const cells = [v.variantId, v.sku, v.productTitle, v.productHandle, v.hasDebenhamsTag, v.productTags.join('|')];
    process.stdout.write(cells.map(c => {
      const s = String(c ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',') + '\n');
  }
}
