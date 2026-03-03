import { ShopifyProduct, MiraklRow, MappingConfig } from '../types';
import { resolveField } from './fieldResolver';
import { logger } from '../logger';

// Maps a Shopify product (all variants) to Mirakl product rows.
// One row per variant — SellerProductId groups them, SellerArticleId identifies each.

export function mapProductToRows(
  product: ShopifyProduct,
  templateHeaders: string[],
  mapping: MappingConfig
): MiraklRow[] {
  const rows: MiraklRow[] = [];

  // For single-variant products (no meaningful options), SellerProductId = SellerArticleId
  const isSingleVariant =
    product.variants.length === 1 &&
    product.variants[0].title === 'Default Title';

  for (const variant of product.variants) {
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

export { normaliseHeaderKey, findDescriptor };
