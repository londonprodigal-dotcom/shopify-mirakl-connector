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
      // Resolve colour option, then map to Debenhams Colour Facet value
      const colorVal = resolveOption(param, variant, mapping);
      if (!colorVal) return 'Multi'; // fallback for products without colour option
      const str = String(colorVal);
      const facet = mapping.colourFacetMappings?.[str];
      if (!facet) return str; // pass through if not in map
      return facet;
    }

    case 'colorfacetlower': {
      // Same as colorfacet but lowercased with underscores (for the 22-value colour list)
      const colorVal2 = resolveOption(param, variant, mapping);
      if (!colorVal2) return 'multi'; // fallback for products without colour option
      const str2 = String(colorVal2);
      const facet2 = mapping.colourFacetMappings?.[str2];
      const result = facet2 || str2;
      return result.toLowerCase().replace(/\s+/g, '_');
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
        return val.toLowerCase();
      }
      return val;
    }
  }
  // Products without a size option are one-size items
  if (aliasGroup === 'size') return 'one_size';
  return null;
}

function resolveImage(
  index: number,
  product: ShopifyProduct,
  variant: ShopifyVariant
): FieldValue {
  // Prefer the variant-specific image for index 0
  if (index === 0 && variant.image?.url) {
    return variant.image.url;
  }
  // Adjust index if variant image takes slot 0
  const adjustedIndex = variant.image?.url ? index - 1 : index;
  const img = product.images[adjustedIndex < 0 ? 0 : adjustedIndex];
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

// Debenhams blocks certain words in titles and descriptions
const BANNED_WORDS = [
  'sustainable', 'eco-friendly', 'eco friendly', 'eco', 'recycled',
  'organic', 'lenzing', 'environmentally', 'chanel', 'chloe', 'alexa',
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

function resolveTag(prefix: string, product: ShopifyProduct): FieldValue {
  const lowerPrefix = prefix.toLowerCase() + ':';
  for (const tag of product.tags) {
    if (tag.toLowerCase().startsWith(lowerPrefix)) {
      return tag.slice(lowerPrefix.length).trim();
    }
  }
  return null;
}
