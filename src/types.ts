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

// ─── Mirakl order types (OR11 response) ──────────────────────────────────────

export interface MiraklOrderAddress {
  firstname: string;
  lastname: string;
  street_1: string;
  street_2?: string;
  city: string;
  zip_code: string;
  country: string;      // ISO 2-letter e.g. "GB"
  country_iso_code?: string;
  phone?: string;
  email?: string;
}

export interface MiraklOrderLine {
  offer_sku: string;    // matches your Shopify variant SKU
  quantity: number;
  price: number;        // unit price
  total_price: number;
  title: string;
  tax_amount?: number;
  order_line_id?: string;
  order_line_state?: string;
}

export interface MiraklOrder {
  order_id: string;
  status?: string;
  order_state?: string;
  customer: MiraklOrderAddress;
  shipping_address: MiraklOrderAddress;
  billing_address: MiraklOrderAddress;
  order_lines: MiraklOrderLine[];
  currency_iso_code: string;
  created_date: string;
  total_price?: number;
}

// ─── Shopify webhook payload types ───────────────────────────────────────────

export interface ShopifyInventoryWebhookPayload {
  inventory_item_id: number;
  available: number;
  location_id: number;
  updated_at?: string;
}

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
  /** Category-specific required attributes: category code → { attribute_code: value } */
  categoryAttributes: Record<string, Record<string, string>>;
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
  pendingProductImport?: {
    importId: string | number;
    offersCsvPath: string;          // saved offers CSV to upload after PA01 completes
    uploadedAt: string;             // ISO 8601
  } | null;
  /** SHA-256 hash of each product's mapped row content, keyed by Shopify product numericId */
  productHashes?: Record<string, string>;
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

// ─── Hardening types ─────────────────────────────────────────────────────────

export interface EventRow {
  id: number;
  fingerprint: string;
  source: string;
  payload: Record<string, unknown>;
  received_at: Date;
}

export interface OrderMapRow {
  id: number;
  mirakl_order_id: string;
  shopify_order_id: number | null;
  shopify_order_name: string | null;
  status: 'pending' | 'created' | 'failed';
  created_at: Date;
  updated_at: Date;
}

export interface StockLedgerRow {
  sku: string;
  shopify_qty: number | null;
  mirakl_qty: number | null;
  buffer_applied: number;
  last_pushed_at: Date | null;
  last_verified_at: Date | null;
  drift_detected: boolean;
}

export interface AlertRow {
  id: number;
  severity: 'info' | 'warning' | 'critical';
  category: string;
  message: string;
  metadata: Record<string, unknown> | null;
  dispatched: boolean;
  created_at: Date;
}
