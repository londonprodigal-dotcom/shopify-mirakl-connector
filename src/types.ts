// ─── Shopify types ────────────────────────────────────────────────────────────

export interface ShopifySelectedOption {
  name: string;
  value: string;
}

export interface ShopifyImage {
  url: string;
  altText: string | null;
}

export interface ShopifyVariant {
  id: string;            // gid://shopify/ProductVariant/123
  numericId: string;     // "123"
  sku: string;
  title: string;         // option combination, e.g. "Red / M"
  price: string;         // "49.99"
  compareAtPrice: string | null;
  barcode: string | null;
  weight: number;
  weightUnit: string;    // KILOGRAMS | GRAMS | POUNDS | OUNCES
  inventoryQuantity: number;
  selectedOptions: ShopifySelectedOption[];
  image: ShopifyImage | null;
}

export interface ShopifyProduct {
  id: string;          // gid://shopify/Product/456
  numericId: string;   // "456"
  title: string;
  descriptionHtml: string;
  description: string; // plain text stripped of HTML
  vendor: string;
  productType: string;
  tags: string[];
  updatedAt: string;   // ISO 8601
  status: string;
  images: ShopifyImage[];
  variants: ShopifyVariant[];
  options: Array<{ name: string; values: string[] }>;
}

// ─── Mirakl types ─────────────────────────────────────────────────────────────

export type MiraklRow = Record<string, string | number | null | undefined>;

export interface MiraklImportResponse {
  import_id: string | number;
}

export interface MiraklImportStatus {
  import_id: string | number;
  status: 'WAITING' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  lines_read: number;
  lines_in_error: number;
  lines_in_success: number;
  lines_in_warning?: number;
  date_created?: string;
  date_updated?: string;
}

// ─── Mapping config types ─────────────────────────────────────────────────────

export interface MappingConfig {
  defaults: Record<string, string | number>;
  categoryMappings: Record<string, string>;
  tagMappings: Record<string, Record<string, string>>;
  colourFacetMappings: Record<string, string>;
  optionAliases: {
    color: string[];
    size: string[];
  };
  productFieldMappings: Record<string, string>;
  offerFieldMappings: Record<string, string>;
}

// ─── Template types ───────────────────────────────────────────────────────────

export type TemplateType = 'products' | 'offers' | 'combined';

export interface TemplateSet {
  products: Template | null;
  offers: Template | null;
  combined: Template | null;
}

export interface Template {
  type: TemplateType;
  filePath: string;
  headers: string[];
}

// ─── State types ──────────────────────────────────────────────────────────────

export interface SyncState {
  lastSuccessfulSync: string | null; // ISO 8601 timestamp
  lastRunAt: string | null;
}

// ─── Sync options & result ────────────────────────────────────────────────────

export interface SyncOptions {
  dryRun: boolean;
  incremental: boolean;
  stockOnly: boolean;
  templatesPath?: string;
}

export interface SyncResult {
  totalProducts: number;
  totalVariants: number;
  productsExported: number;
  offersExported: number;
  skipped: number;
  failed: number;
  errors: Array<{ identifier: string; reason: string }>;
  miraklImportId?: string | number;
  miraklStatus?: string;
}
