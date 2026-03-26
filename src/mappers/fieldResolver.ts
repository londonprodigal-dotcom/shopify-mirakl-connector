/**
 * Resolves a field mapping descriptor against a Shopify product/variant.
 *
 * Descriptor format (from mapping.yaml):
 *   "field:<path>"      – read from product or variant (dot notation)
 *   "static:<value>"    – literal value
 *   "default:<key>"     – value from mapping.defaults section
 *   "option:<alias>"    – read from variant.selectedOptions using alias group
 *   "image:<index>"     – product image URL at 0-based index
 *   "mapped:<field>"    – apply categoryMappings to the given field value
 *   "tag:<prefix>"      – find tag starting with prefix and return the suffix
 */

import { ShopifyProduct, ShopifyVariant, MappingConfig } from '../types';

type FieldValue = string | number | null | undefined;

export function resolveField(
  descriptor: string,
  product: ShopifyProduct,
  variant: ShopifyVariant,
  mapping: MappingConfig
): FieldValue {
  const colonIdx = descriptor.indexOf(':');
  if (colonIdx === -1) return undefined;

  const type  = descriptor.slice(0, colonIdx).trim();
  const param = descriptor.slice(colonIdx + 1).trim();

  switch (type) {
    case 'field':
      return resolveFieldPath(param, product, variant);

    case 'static':
      return param;

    case 'default':
      return String(mapping.defaults[param] ?? '');

    case 'option':
      return resolveOption(param, variant, mapping);

    case 'image':
      return resolveImage(Number(param), product, variant);

    case 'mapped':
      return resolveMapped(param, product, mapping);

    case 'tag':
      return resolveTag(param, product);

    case 'colorfacet': {
      // Resolve colour via cascading fallbacks:
      // 1. Variant option (Color/Colour)
      // 2. Product title after " - "
      // 3. Variant title (e.g. "Navy / 10")
      // 4. Product tags (colour:X)
      // 5. Default "Multi"
      const colorVal =
        resolveOption(param, variant, mapping) ??
        extractColourFromTitle(product.title, mapping) ??
        extractColourFromVariantTitle(variant, mapping) ??
        extractColourFromTags(product, mapping);
      if (!colorVal) return 'Multi';
      const str = String(colorVal);
      // For slash combos like "Green/Black" that would map to "Multi",
      // try the primary (first) colour instead
      const facet = lookupColourFacet(str, mapping);
      if (facet === 'Multi' || (!facet && str.includes('/'))) {
        const primary = extractPrimaryFromCombo(str, mapping);
        if (primary) return lookupColourFacet(primary, mapping) ?? primary;
      }
      if (!facet) return str;
      return facet;
    }

    case 'colorfacetlower': {
      // Same as colorfacet but lowercased with underscores (for the 22-value colour list)
      const colorVal2 =
        resolveOption(param, variant, mapping) ??
        extractColourFromTitle(product.title, mapping) ??
        extractColourFromVariantTitle(variant, mapping) ??
        extractColourFromTags(product, mapping);
      if (!colorVal2) return 'multi';
      const str2 = String(colorVal2);
      const facet2 = lookupColourFacet(str2, mapping);
      if (facet2 === 'Multi' || (!facet2 && str2.includes('/'))) {
        const primary2 = extractPrimaryFromCombo(str2, mapping);
        if (primary2) {
          const pf = lookupColourFacet(primary2, mapping) ?? primary2;
          return pf.toLowerCase().replace(/\s+/g, '_');
        }
      }
      const result = facet2 || str2;
      return result.toLowerCase().replace(/\s+/g, '_');
    }

    case 'pricefull': {
      // Mirakl "price" = full/original price.
      // If compareAtPrice exists and is higher than price, use it as the full price.
      // Otherwise use the current price.
      const compare = parseFloat(variant.compareAtPrice || '0');
      const current = parseFloat(variant.price || '0');
      return (compare > current) ? compare.toFixed(2) : current.toFixed(2);
    }

    case 'pricesale': {
      // Mirakl "discount-price" = sale price (must be lower than "price").
      // Only set when product is actually on sale (compareAtPrice > price).
      const cmp = parseFloat(variant.compareAtPrice || '0');
      const cur = parseFloat(variant.price || '0');
      return (cmp > cur) ? cur.toFixed(2) : null;
    }

    case 'sanitized': {
      // Resolve a field value and strip banned marketplace words
      const rawVal = resolveFieldPath(param, product, variant);
      if (!rawVal) return null;
      return sanitizeBannedWords(String(rawVal));
    }

    default:
      return undefined;
  }
}

// ─── Sub-resolvers ────────────────────────────────────────────────────────────

function resolveFieldPath(
  path: string,
  product: ShopifyProduct,
  variant: ShopifyVariant
): FieldValue {
  // Supports: "product.title", "variant.price", etc.
  const [root, ...rest] = path.split('.');
  const key = rest.join('.');

  let obj: Record<string, unknown>;
  if (root === 'product') {
    obj = product as unknown as Record<string, unknown>;
  } else if (root === 'variant') {
    obj = variant as unknown as Record<string, unknown>;
  } else {
    return undefined;
  }

  // Allow simple single-level keys after root
  const value = obj[key];

  if (Array.isArray(value)) {
    return (value as unknown[]).join(', ');
  }

  if (value === null || value === undefined) {
    return null;
  }

  return value as FieldValue;
}

function resolveOption(
  aliasGroup: string,
  variant: ShopifyVariant,
  mapping: MappingConfig
): FieldValue {
  const aliases =
    aliasGroup === 'color'
      ? mapping.optionAliases.color
      : aliasGroup === 'size'
      ? mapping.optionAliases.size
      : [aliasGroup];

  for (const option of variant.selectedOptions) {
    if (aliases.some((a) => a.toLowerCase() === option.name.toLowerCase())) {
      const val = option.value;
      // Mirakl size values must be lowercase (e.g. "s" not "S")
      if (aliasGroup === 'size' && val) {
        return normaliseSizeValue(val);
      }
      return val;
    }
  }
  // Products without a size option are one-size items
  if (aliasGroup === 'size') return 'one_size';
  return null;
}

/**
 * Returns true if an image URL looks like a swatch/thumbnail (typically < 1080px).
 * Debenhams requires all images to be min 1080px on the short side.
 */
function isSwatchImage(url: string): boolean {
  return /swatch/i.test(url);
}

function resolveImage(
  index: number,
  product: ShopifyProduct,
  variant: ShopifyVariant
): FieldValue {
  // Filter out swatch images — they are almost always below the 1080px minimum
  const fullSizeImages = product.images.filter((img) => !isSwatchImage(img.url));

  // Prefer the variant-specific image for index 0 (if not a swatch)
  if (index === 0 && variant.image?.url && !isSwatchImage(variant.image.url)) {
    return variant.image.url;
  }
  // Adjust index if variant image takes slot 0
  const hasVariantImage = variant.image?.url && !isSwatchImage(variant.image.url);
  const adjustedIndex = hasVariantImage ? index - 1 : index;
  const img = fullSizeImages[adjustedIndex < 0 ? 0 : adjustedIndex];
  return img?.url ?? null;
}

function resolveMapped(
  fieldPath: string,
  product: ShopifyProduct,
  mapping: MappingConfig
): FieldValue {
  const [root, key] = fieldPath.split('.');
  if (root !== 'product') return undefined;

  const rawValue = (product as unknown as Record<string, unknown>)[key];
  const strValue = String(rawValue ?? '');

  // Try exact match, then case-insensitive
  const direct = mapping.categoryMappings[strValue];
  if (direct) return direct;

  const lower = strValue.toLowerCase();
  for (const [k, v] of Object.entries(mapping.categoryMappings)) {
    if (k.toLowerCase() === lower) return v;
  }

  // Fallback
  return mapping.categoryMappings['_default'] ?? strValue;
}

// Debenhams blocks certain words in titles and descriptions.
// "louche" is the brand name — Debenhams requires brand-free titles (brand is set via collection field).
const BANNED_WORDS = [
  'louche',
  'sustainable', 'eco-friendly', 'eco friendly', 'eco', 'recycled',
  'organic', 'lenzing', 'environmentally', 'chanel', 'chloe', 'alexa',
  'courtney',
];

function sanitizeBannedWords(text: string): string {
  let result = text;
  for (const word of BANNED_WORDS) {
    // Case-insensitive whole-word replacement
    const regex = new RegExp(`\\b${word.replace(/-/g, '[-\\s]?')}\\b`, 'gi');
    result = result.replace(regex, '');
  }
  // Clean up extra whitespace
  return result.replace(/\s{2,}/g, ' ').trim();
}

// Valid Mirakl size_womens values (from Debenhams value list)
const VALID_SIZES = new Set([
  '10','10-11','10-12','10-12r','10-12s','10-14','10.5-11','11-12','11-12.5','11-13',
  '12','12-14','12.5-5.5','14','14-16','14-16r','14-16s','14-18','14-20','1.5-3',
  '16','16-18','16-20','18','18-20','18-20r','18-20s','18-22','2','20','20-22',
  '20-24','22','22-24','22-24r','22-24s','22-26','22-28','2-3.5','24','24-26',
  '2-5','2.5-3.5','2.5-4','2.5-4.5','2.5-5','2.5-6','2.5-6.5','26','26-28',
  '28','28-30','28-32','3','30','30-32','32','32-34','32dd','32e','32g','34',
  '3-4','34-36','3-4.5','3-5','3-5.5','3.5-5','3.5-5.5','3.5-7','3.5-7.5',
  '3.5-8','36','3-6','3-6.5','3-7','38','3-8','38-40','3-8.5','3-9','4','40',
  '4-11','42','42-44','44','4-5','4.5-5.5','4.5-6','46','4-6','46-48','4-6.5',
  '4-7','48','4-8','4-9','4xl','5','50','50-52','52','54','54-56','5.5-6.5',
  '5.5-7','56','5-6','5-8','5xl','6','6.5-8','6-7','6-8','6.8-5','6-9','6xl',
  '7','7-11','7.5-8.5','7-8','7-9','7xl','8','8-10','8-11','8.5-10','8xl',
  '9','9-10','l','l/xl','m','m/l','one_size','s','s/m','s-m','xl','xl/xxl',
  'xs','xs/s','xxl','xxl/xxxl','xxs','xxs/xs','xxxl','xxxs',
  '10s','10r','10l','10xl','12r','12s','12l','12xl','14r','14s','14l','14xl',
  '16r','16s','16l','16xl','18r','18s','18l','18xl','20r','20s','20l','20xl',
  '22r','22s','22l','22xl','24r','24s','24l','24xl','2xl','3xl',
  '8r','8s','8l','1x','2x','3x','4x','m_tall','yl','ym','ys','yxl','yxs',
]);

function normaliseSizeValue(val: string): string {
  let normalised = val.toLowerCase().trim();
  // "One Size" / "one size" → one_size
  if (normalised === 'one size' || normalised === 'onesize') return 'one_size';
  // "Default Title" → one_size
  if (normalised === 'default title') return 'one_size';
  // If the value is a valid Mirakl size, use it
  if (VALID_SIZES.has(normalised)) return normalised;
  // Otherwise fall back to one_size (e.g. letter initials, colour names used as size)
  return 'one_size';
}

/**
 * For slash-separated colour combos (e.g. "Green/Black"), extract the first colour
 * and look it up in colourFacetMappings. Returns the first colour if it maps to a
 * non-Multi facet, otherwise returns null to let caller decide.
 */
function extractPrimaryFromCombo(colorValue: string, mapping: MappingConfig): string | null {
  if (!colorValue.includes('/')) return null;
  const first = colorValue.split('/')[0]!.trim();
  if (!first) return null;
  // Check if the first part maps to a specific (non-Multi) facet
  const facet = lookupColourFacet(first, mapping);
  if (facet && facet !== 'Multi') return first;
  return null;
}

/**
 * Case-insensitive lookup in colourFacetMappings.
 */
function lookupColourFacet(color: string, mapping: MappingConfig): string | null {
  if (mapping.colourFacetMappings?.[color]) return mapping.colourFacetMappings[color]!;
  const lower = color.toLowerCase();
  for (const [k, v] of Object.entries(mapping.colourFacetMappings ?? {})) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * Extract colour from product title using the "Product Name - Colour" pattern.
 * Tries exact match first, then case-insensitive match against colourFacetMappings.
 * Returns the matched colour string (as-is from the title), or null if no match.
 */
function extractColourFromTitle(title: string, mapping: MappingConfig): string | null {
  // Try splitting on " - " and taking the last segment
  const dashIdx = title.lastIndexOf(' - ');
  if (dashIdx === -1) return null;

  const candidate = title.slice(dashIdx + 3).trim();
  if (!candidate) return null;

  // Check if the candidate (or part of it) matches a known colour in the facet mappings
  if (mapping.colourFacetMappings?.[candidate]) return candidate;

  // Try case-insensitive match
  const lower = candidate.toLowerCase();
  for (const key of Object.keys(mapping.colourFacetMappings ?? {})) {
    if (key.toLowerCase() === lower) return key;
  }

  // The candidate might be a colour not in the mapping — return it raw
  // so the colorfacet resolver can pass it through
  return candidate;
}

/**
 * Scan variant title (e.g. "Navy / 10") for a known colour from colourFacetMappings.
 * Returns the first matched colour, or null.
 */
function extractColourFromVariantTitle(variant: ShopifyVariant, mapping: MappingConfig): string | null {
  // Variant titles typically look like "Navy / 10" or "Green / M"
  const parts = variant.title.split(/\s*\/\s*/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (lookupColourFacet(trimmed, mapping)) return trimmed;
  }
  return null;
}

/**
 * Check product tags for a colour: prefix (e.g. "colour:Navy").
 */
function extractColourFromTags(product: ShopifyProduct, mapping: MappingConfig): string | null {
  for (const tag of product.tags) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('colour:') || lower.startsWith('color:')) {
      const val = tag.slice(tag.indexOf(':') + 1).trim();
      if (val && lookupColourFacet(val, mapping)) return val;
    }
  }
  return null;
}

function resolveTag(prefix: string, product: ShopifyProduct): FieldValue {
  const lowerPrefix = prefix.toLowerCase() + ':';
  for (const tag of product.tags) {
    if (tag.toLowerCase().startsWith(lowerPrefix)) {
      return tag.slice(lowerPrefix.length).trim();
    }
  }
  return null;
}
