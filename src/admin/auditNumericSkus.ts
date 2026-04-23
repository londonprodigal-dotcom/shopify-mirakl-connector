/**
 * Read-only audit: find Louche Shopify variants whose SKU matches the legacy
 * Debenhams-issued numeric pattern (/^10[0-9]{7}$/). These SKUs predate the
 * current PRODUCT-COLOUR-SIZE convention and are a root cause of catalog_orphan
 * skipped stock_update jobs — Mirakl no longer has offers under these numeric
 * IDs, so every Shopify inventory change for them produces a skipped job.
 *
 * Emits two CSV sections to stdout:
 *   === ACTIONABLE === : sibling variants follow a consistent PREFIX-<size>
 *                        convention, so the replacement for this variant is
 *                        deterministically inferrable (PREFIX-<this size>).
 *   === TRIAGE ===     : no confident inference possible; operator decides.
 *
 * No Shopify writes. Run inside the Railway container (production credentials):
 *   railway ssh -s worker "node /app/dist/index.js admin audit-numeric-skus"
 */

import { loadConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';

// Match any all-digit SKU of length 5+ — these are the legacy Debenhams-issued
// IDs still lingering on Louche variants after remapping. Observed length in
// the wild is 8 chars (e.g. "10100424"), but we accept 5-12 to be robust to
// future variants while rejecting size-only strings ("10", "12").
const NUMERIC_SKU_RE = /^[0-9]{5,12}$/;

interface VariantRow {
  productId: string;
  productTitle: string;
  productHandle: string;
  productStatus: string;
  variantId: string;
  variantTitle: string;
  sku: string;
  size: string | null;
}

interface AuditRow {
  variantId: string;
  currentSku: string;
  productTitle: string;
  productHandle: string;
  productStatus: string;
  variantTitle: string;
  legacySkuPattern: boolean;
  siblingPrefix: string | null;
  suggestedReplacementSku: string;
  recommendedAction: 'replace_with_inferred' | 'manual_triage' | 'archive_or_delete';
  dueDate: string;
}

interface VariantNode {
  id: string;
  sku: string | null;
  title: string;
  selectedOptions: Array<{ name: string; value: string }>;
  product: { id: string; title: string; handle: string; status: string };
}
interface VariantQueryResponse {
  data?: {
    productVariants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: VariantNode }>;
    };
  };
}

async function fetchAllLouchVariants(shopify: ShopifyClient): Promise<VariantRow[]> {
  // No product-status filter — the known numeric-SKU orphans may live on
  // archived/draft variants that still fire inventory webhooks. We audit every
  // variant and surface product_status in the output so the operator can triage.
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
            product { id title handle status }
          }
        }
      }
    }
  `;

  const rows: VariantRow[] = [];
  let cursor: string | null = null;
  const gqlClient = shopify as unknown as { gql: <T>(q: string, v: Record<string, unknown>) => Promise<T> };
  do {
    const r: VariantQueryResponse = await gqlClient.gql<VariantQueryResponse>(QUERY, { cursor });
    const vs = r.data?.productVariants;
    if (!vs) break;
    for (const edge of vs.edges) {
      const v = edge.node;
      const sizeOpt = v.selectedOptions.find((o: { name: string; value: string }) => /^(size|uk size)$/i.test(o.name));
      rows.push({
        productId: v.product.id,
        productTitle: v.product.title,
        productHandle: v.product.handle,
        productStatus: v.product.status,
        variantId: v.id,
        variantTitle: v.title,
        sku: v.sku ?? '',
        size: sizeOpt?.value ?? null,
      });
    }
    cursor = vs.pageInfo.hasNextPage ? vs.pageInfo.endCursor : null;
  } while (cursor);

  return rows;
}

function inferProductSkuPrefix(variants: VariantRow[]): string | null {
  const nonNumeric = variants.filter(v => v.sku && !NUMERIC_SKU_RE.test(v.sku) && v.size);
  if (nonNumeric.length < 2) return null;
  const prefixes = new Set<string>();
  for (const v of nonNumeric) {
    const sizeSuffix = new RegExp(`[-_ ]${v.size}\\s*$`, 'i');
    if (sizeSuffix.test(v.sku)) {
      prefixes.add(v.sku.replace(sizeSuffix, ''));
    }
  }
  if (prefixes.size === 1) return [...prefixes][0];
  return null;
}

function toCsvLine(r: AuditRow): string {
  const cells = [
    r.variantId, r.currentSku, r.productTitle, r.productHandle, r.productStatus,
    r.variantTitle, r.legacySkuPattern, r.siblingPrefix ?? '',
    r.suggestedReplacementSku, r.recommendedAction, r.dueDate,
  ];
  return cells.map(v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

export async function auditNumericSkus(): Promise<void> {
  const config = loadConfig();
  const shopify = new ShopifyClient(config);

  process.stderr.write('Fetching all active Louche variants…\n');
  const variants = await fetchAllLouchVariants(shopify);
  process.stderr.write(`  → ${variants.length} variants\n`);

  const byProduct = new Map<string, VariantRow[]>();
  for (const v of variants) {
    const arr = byProduct.get(v.productId) ?? [];
    arr.push(v);
    byProduct.set(v.productId, arr);
  }

  const dueDate = new Date(Date.now() + 14 * 24 * 3600_000).toISOString().slice(0, 10);
  const actionable: AuditRow[] = [];
  const triage: AuditRow[] = [];

  for (const [, productVariants] of byProduct) {
    const numeric = productVariants.filter(v => NUMERIC_SKU_RE.test(v.sku));
    if (numeric.length === 0) continue;
    const prefix = inferProductSkuPrefix(productVariants);
    for (const v of numeric) {
      const productLive = v.productStatus === 'ACTIVE';
      const canInfer = !!prefix && !!v.size;
      const suggested = canInfer ? `${prefix}-${v.size}` : '';
      const action: AuditRow['recommendedAction'] = !productLive
        ? 'archive_or_delete'
        : (canInfer ? 'replace_with_inferred' : 'manual_triage');
      const row: AuditRow = {
        variantId: v.variantId,
        currentSku: v.sku,
        productTitle: v.productTitle,
        productHandle: v.productHandle,
        productStatus: v.productStatus,
        variantTitle: v.variantTitle,
        legacySkuPattern: true,
        siblingPrefix: prefix,
        suggestedReplacementSku: suggested,
        recommendedAction: action,
        dueDate,
      };
      if (action === 'replace_with_inferred') actionable.push(row);
      else triage.push(row);
    }
  }

  const header = [
    'variant_id', 'current_sku', 'product_title', 'product_handle', 'product_status',
    'variant_title', 'legacy_sku_pattern', 'sibling_prefix',
    'suggested_replacement_sku', 'recommended_action', 'due_date',
  ].join(',');

  process.stdout.write('=== SUMMARY ===\n');
  process.stdout.write(`total_variants=${variants.length}\n`);
  process.stdout.write(`actionable_count=${actionable.length}\n`);
  process.stdout.write(`triage_count=${triage.length}\n`);
  process.stdout.write(`due_date=${dueDate}\n`);
  process.stdout.write('\n=== ACTIONABLE ===\n');
  process.stdout.write(header + '\n');
  for (const r of actionable) process.stdout.write(toCsvLine(r) + '\n');
  process.stdout.write('\n=== TRIAGE ===\n');
  process.stdout.write(header + '\n');
  for (const r of triage) process.stdout.write(toCsvLine(r) + '\n');
}
