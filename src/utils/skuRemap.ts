import { query } from '../db/pool';
import { logger } from '../logger';

// In-memory cache: shopifySku ↔ miraklSku
let forwardMap = new Map<string, string>();  // shopify → mirakl
let reverseMap = new Map<string, string>();  // mirakl → shopify

export async function loadRemapCache(): Promise<void> {
  try {
    const result = await query<{ shopify_sku: string; mirakl_sku: string }>(
      `SELECT shopify_sku, mirakl_sku FROM sku_remap WHERE new_offer_created = TRUE`
    );
    const fwd = new Map<string, string>();
    const rev = new Map<string, string>();
    for (const row of result.rows) {
      fwd.set(row.shopify_sku, row.mirakl_sku);
      rev.set(row.mirakl_sku, row.shopify_sku);
    }
    forwardMap = fwd;
    reverseMap = rev;
    if (fwd.size > 0) {
      logger.info('SKU remap cache loaded', { count: fwd.size });
    }
  } catch (err) {
    // Table may not exist yet (migration hasn't run) — ignore
    logger.debug('SKU remap cache load skipped', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Shopify SKU → Mirakl SKU (appends suffix if remapped) */
export function toMiraklSku(shopifySku: string): string {
  return forwardMap.get(shopifySku) ?? shopifySku;
}

/** Mirakl SKU → Shopify SKU (strips suffix if remapped) */
export function toShopifySku(miraklSku: string): string {
  return reverseMap.get(miraklSku) ?? miraklSku;
}

export function getRemapCount(): number {
  return forwardMap.size;
}
