import { ShopifyProduct, MiraklRow, MappingConfig } from '../types';
import { resolveField } from './fieldResolver';
import { normaliseHeaderKey, findDescriptor } from './productMapper';
import { logger } from '../logger';

/**
 * Maps a Shopify product's variants to Mirakl offer rows.
 * Each variant becomes one offer row.
 *
 * In stock-only mode, only quantity/price fields are included.
 */
export function mapOfferToRows(
  product: ShopifyProduct,
  templateHeaders: string[],
  mapping: MappingConfig,
  stockOnly: boolean = false
): MiraklRow[] {
  const rows: MiraklRow[] = [];

  // Fields that constitute "stock only" — everything else is omitted
  const STOCK_ONLY_HEADERS = new Set([
    'sku',
    'seller-article-id',
    'seller-product-id',
    'product-id',
    'price',
    'quantity',
    'update-delete',
    'currency-iso-code',
  ]);

  const isSingleVariant =
    product.variants.length === 1 &&
    product.variants[0].title === 'Default Title';

  for (const variant of product.variants) {
    if (!variant.sku) {
      logger.warn(
        `Product "${product.title}" variant "${variant.title}" has no SKU — skipping offer`,
        { productId: product.numericId, variantId: variant.numericId }
      );
      continue;
    }

    const row: MiraklRow = {};

    for (const header of templateHeaders) {
      if (!header) continue;

      const normHeader = normaliseHeaderKey(header);

      // In stock-only mode, skip non-stock fields
      if (stockOnly && !STOCK_ONLY_HEADERS.has(normHeader)) {
        row[header] = '';
        continue;
      }

      const descriptor = findDescriptor(normHeader, mapping.offerFieldMappings);

      if (descriptor) {
        row[header] = resolveField(descriptor, product, variant, mapping);
      } else {
        row[header] = '';
      }
    }

    // Enforce identifier fields regardless of template mapping
    enforceOfferIds(row, product, variant, isSingleVariant, templateHeaders);

    // Validate price is present and numeric
    validateOfferRow(row, product, variant);

    rows.push(row);
  }

  return rows;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function enforceOfferIds(
  row: MiraklRow,
  product: ShopifyProduct,
  variant: { numericId: string; sku: string },
  isSingleVariant: boolean,
  headers: string[]
): void {
  // Mirakl identifies an offer by seller-product-id + seller-article-id (or sku).
  // SellerProductId groups variants of the same parent style.
  const find = (norm: string) =>
    headers.find((h) => normaliseHeaderKey(h) === norm);

  const skuKey           = find('sku');
  const sellerProductKey = find('seller-product-id');
  const sellerArticleKey = find('seller-article-id');

  if (skuKey)           row[skuKey]           = variant.sku;
  if (sellerProductKey) row[sellerProductKey] = product.numericId;
  if (sellerArticleKey) {
    row[sellerArticleKey] = isSingleVariant ? product.numericId : variant.numericId;
  }
}

function validateOfferRow(
  row: MiraklRow,
  product: ShopifyProduct,
  variant: { sku: string; price: string }
): void {
  const priceKey = Object.keys(row).find(
    (k) => normaliseHeaderKey(k) === 'price'
  );

  if (priceKey) {
    const price = parseFloat(String(row[priceKey] ?? ''));
    if (isNaN(price) || price < 0) {
      logger.warn(
        `Invalid price for SKU "${variant.sku}" in product "${product.title}" — will be set to 0`,
        { rawPrice: row[priceKey] }
      );
      row[priceKey] = '0.00';
    }
  }
}
