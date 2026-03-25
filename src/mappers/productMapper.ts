import { ShopifyProduct, MiraklRow, MappingConfig } from '../types';
import { resolveField } from './fieldResolver';
import { logger } from '../logger';

// Maps a Shopify product (all variants) to Mirakl product rows.
// One row per variant — SellerProductId groups them, SellerArticleId identifies each.

export function mapProductToRows(
  product: ShopifyProduct,
  templateHeaders: string[],
  mapping: MappingConfig,
  imageProxyBaseUrl?: string
): MiraklRow[] {
  const rows: MiraklRow[] = [];

  // For single-variant products (no meaningful options), SellerProductId = SellerArticleId
  const isSingleVariant =
    product.variants.length === 1 &&
    product.variants[0].title === 'Default Title';

  for (const variant of product.variants) {
    if (!variant.barcode || !variant.barcode.trim()) {
      logger.warn(
        `Product "${product.title}" variant "${variant.title}" has no barcode (EAN required) — skipping`,
        { productId: product.numericId, variantId: variant.numericId }
      );
      continue;
    }

    if (!variant.sku && !variant.barcode) {
      logger.warn(
        `Product "${product.title}" variant "${variant.title}" has no SKU or barcode — skipping`,
        { productId: product.numericId, variantId: variant.numericId }
      );
      continue;
    }

    const row: MiraklRow = {};

    for (const header of templateHeaders) {
      if (!header) continue;

      // Look up the descriptor for this header (case-insensitive, normalised key)
      const normHeader = normaliseHeaderKey(header);
      const descriptor = findDescriptor(normHeader, mapping.productFieldMappings);

      if (descriptor) {
        row[header] = resolveField(descriptor, product, variant, mapping);
      } else {
        // No mapping configured — leave blank (Mirakl will use defaults)
        row[header] = '';
      }
    }

    // Enforce SellerProductId / SellerArticleId rules regardless of template mapping
    overrideIds(row, product, variant, isSingleVariant, templateHeaders);

    // Apply category-specific required attributes (fill empty columns only)
    applyCategoryAttributes(row, product, templateHeaders, mapping);

    // Rewrite Shopify CDN image URLs to proxy for DPI compliance
    if (imageProxyBaseUrl) {
      rewriteImageUrls(row, imageProxyBaseUrl);
    }

    rows.push(row);
  }

  return rows;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a template header to a lookup key:
 * lowercase, spaces and underscores become hyphens.
 */
function normaliseHeaderKey(header: string): string {
  return header.toLowerCase().replace(/[\s_]+/g, '-').trim();
}

/**
 * Find a descriptor from the fieldMappings by normalised key.
 */
function findDescriptor(
  normHeader: string,
  fieldMappings: Record<string, string>
): string | undefined {
  // Direct match first
  if (fieldMappings[normHeader]) return fieldMappings[normHeader];

  // Normalise all mapping keys and compare
  for (const [k, v] of Object.entries(fieldMappings)) {
    if (normaliseHeaderKey(k) === normHeader) return v;
  }
  return undefined;
}

/**
 * Ensure SellerProductId and SellerArticleId follow Mirakl's variant grouping rules.
 * We do this after the generic mapping so explicit template columns are overridden.
 */
function overrideIds(
  row: MiraklRow,
  product: ShopifyProduct,
  variant: { numericId: string },
  isSingleVariant: boolean,
  headers: string[]
): void {
  const sellerProductKey = headers.find(
    (h) => normaliseHeaderKey(h) === 'seller-product-id'
  );
  const sellerArticleKey = headers.find(
    (h) => normaliseHeaderKey(h) === 'seller-article-id'
  );

  if (sellerProductKey) {
    row[sellerProductKey] = product.numericId;
  }
  if (sellerArticleKey) {
    row[sellerArticleKey] = isSingleVariant ? product.numericId : variant.numericId;
  }
}

/**
 * Apply category-specific required attributes from mapping.categoryAttributes.
 * Only fills columns that are currently empty or missing.
 */
function applyCategoryAttributes(
  row: MiraklRow,
  product: ShopifyProduct,
  headers: string[],
  mapping: MappingConfig
): void {
  // Determine which category this product was mapped to
  const categoryHeader = headers.find(
    (h) => normaliseHeaderKey(h) === 'product-category'
  );
  if (!categoryHeader) return;

  const categoryCode = String(row[categoryHeader] ?? '');
  if (!categoryCode) return;

  const attrs = mapping.categoryAttributes[categoryCode];
  if (!attrs) return;

  for (const [attrCode, defaultValue] of Object.entries(attrs)) {
    // Find matching header in template (normalised match)
    const normAttr = normaliseHeaderKey(attrCode);
    const header = headers.find((h) => normaliseHeaderKey(h) === normAttr);
    if (!header) continue;

    // Only fill if currently empty
    const current = row[header];
    if (current === undefined || current === null || current === '') {
      row[header] = defaultValue;
    }
  }
}

/**
 * Request a larger version of a Shopify CDN image.
 * Shopify supports on-the-fly resizing via URL width param — append &width=1200
 * to get a 1200px wide version (height scales proportionally).
 * This ensures the source image delivered to the proxy is already ≥1080px.
 */
function ensureMinWidth(url: string, minWidth = 1200): string {
  // Shopify CDN URLs support ?width=N or &width=N
  if (url.includes('width=')) return url; // already has a width param
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}width=${minWidth}`;
}

/**
 * Rewrite Shopify CDN image URLs:
 * 1. Request ≥1200px wide from Shopify CDN (ensures source is large enough)
 * 2. Route through the image proxy for DPI fix + resize safety net
 */
function rewriteImageUrls(row: MiraklRow, proxyBaseUrl: string): void {
  const base = proxyBaseUrl.replace(/\/$/, '');
  for (const key of Object.keys(row)) {
    const val = row[key];
    if (typeof val === 'string' && val.startsWith('https://cdn.shopify.com/')) {
      const upsized = ensureMinWidth(val);
      row[key] = `${base}/img?url=${encodeURIComponent(upsized)}`;
    }
  }
}

export { normaliseHeaderKey, findDescriptor };
