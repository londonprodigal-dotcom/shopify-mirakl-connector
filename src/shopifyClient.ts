import { AppConfig } from './config';
import { ShopifyProduct, ShopifyVariant, ShopifyImage, MiraklOrder } from './types';
import { logger } from './logger';

// ─── GraphQL query ────────────────────────────────────────────────────────────

const PRODUCTS_QUERY = `
  query GetProducts($cursor: String, $query: String) {
    products(first: 50, after: $cursor, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          descriptionHtml
          vendor
          productType
          tags
          updatedAt
          status
          images(first: 12) {
            edges {
              node {
                url(transform: { maxWidth: 2048 })
                altText
                width
                height
              }
            }
          }
          options {
            name
            values
          }
          variants(first: 100) {
            edges {
              node {
                id
                sku
                title
                price
                compareAtPrice
                barcode
                inventoryQuantity
                selectedOptions {
                  name
                  value
                }
                image {
                  url(transform: { maxWidth: 2048 })
                  altText
                  width
                  height
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ─── Response shape ───────────────────────────────────────────────────────────

interface GqlVariantNode {
  id: string;
  sku: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  barcode: string | null;
  inventoryQuantity: number;
  selectedOptions: Array<{ name: string; value: string }>;
  image: { url: string; altText: string | null; width?: number; height?: number } | null;
}

interface GqlProductNode {
  id: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  updatedAt: string;
  status: string;
  images: { edges: Array<{ node: { url: string; altText: string | null; width?: number; height?: number } }> };
  options: Array<{ name: string; values: string[] }>;
  variants: { edges: Array<{ node: GqlVariantNode }> };
}

interface GqlResponse {
  data?: {
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: GqlProductNode }>;
    };
  };
  errors?: Array<{ message: string; locations?: unknown; path?: unknown }>;
}

// ─── Helper: strip HTML tags ──────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Helper: fix scientific notation barcodes ────────────────────────────────

/**
 * Validate EAN/UPC check digit using the GS1 algorithm.
 * Works for EAN-8, UPC-12 (UPC-A), and EAN-13.
 */
function isValidCheckDigit(barcode: string): boolean {
  const digits = barcode.split('').map(Number);
  const len = digits.length;

  let sum = 0;
  for (let i = 0; i < len - 1; i++) {
    // EAN-13: weights 1,3,1,3... ; EAN-8 / UPC-12: weights 3,1,3,1...
    const weight = len === 13
      ? (i % 2 === 0 ? 1 : 3)
      : (i % 2 === 0 ? 3 : 1);
    sum += digits[i]! * weight;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === digits[len - 1];
}

function normaliseBarcode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let bc = raw.trim();
  if (bc === '') return null;
  // Scientific notation means the real digits are lost — treat as no barcode
  if (bc.includes('E+') || bc.includes('e+')) {
    return null;
  }
  // Must contain only digits and be a valid length (EAN-8, UPC-12, EAN-13)
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(bc)) {
    return null;
  }
  // Validate check digit — Mirakl rejects barcodes with invalid check digits
  if (!isValidCheckDigit(bc)) {
    return null;
  }
  return bc;
}

// ─── Helper: extract numeric ID from GID ─────────────────────────────────────

function numericId(gid: string): string {
  // gid://shopify/Product/1234567890 → "1234567890"
  const parts = gid.split('/');
  return parts[parts.length - 1] ?? gid;
}

// ─── Normalise raw GraphQL nodes ──────────────────────────────────────────────

function normaliseVariant(raw: GqlVariantNode): ShopifyVariant {
  return {
    id: raw.id,
    numericId: numericId(raw.id),
    sku: raw.sku ?? '',
    title: raw.title,
    price: raw.price,
    compareAtPrice: raw.compareAtPrice ?? null,
    barcode: normaliseBarcode(raw.barcode),
    weight: 0,
    weightUnit: 'KILOGRAMS',
    inventoryQuantity: raw.inventoryQuantity ?? 0,
    selectedOptions: raw.selectedOptions ?? [],
    image: raw.image ?? null,
  };
}

function normaliseProduct(raw: GqlProductNode): ShopifyProduct {
  const images: ShopifyImage[] = raw.images.edges.map((e) => ({
    url: e.node.url,
    altText: e.node.altText,
    width: e.node.width,
    height: e.node.height,
  }));

  const variants: ShopifyVariant[] = raw.variants.edges.map((e) =>
    normaliseVariant(e.node)
  );

  return {
    id: raw.id,
    numericId: numericId(raw.id),
    title: raw.title,
    descriptionHtml: raw.descriptionHtml,
    description: stripHtml(raw.descriptionHtml),
    vendor: raw.vendor ?? '',
    productType: raw.productType ?? '',
    tags: raw.tags ?? [],
    updatedAt: raw.updatedAt,
    status: raw.status,
    images,
    variants,
    options: raw.options ?? [],
  };
}

// ─── ShopifyClient ────────────────────────────────────────────────────────────

export class ShopifyClient {
  private readonly endpoint: string;
  private readonly restBaseUrl: string;
  private readonly storeDomain: string;
  private headers: Record<string, string>;

  // OAuth client credentials state
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private oauthToken: string | null = null;
  private oauthExpiresAt: number = 0;  // Unix ms

  constructor(config: AppConfig) {
    this.endpoint    = config.shopify.graphqlEndpoint;
    this.restBaseUrl = config.shopify.restBaseUrl;
    this.storeDomain = config.shopify.storeDomain;
    this.clientId    = config.shopify.clientId;
    this.clientSecret = config.shopify.clientSecret;
    this.headers = {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.shopify.adminAccessToken,
    };
  }

  // ─── OAuth client credentials flow ─────────────────────────────────────────

  /**
   * Exchange client_id + client_secret for an access token via Shopify's
   * OAuth client credentials grant. Token expires in ~24h (86400s);
   * we refresh 5 minutes before expiry to avoid mid-request failures.
   */
  private async refreshOAuthToken(): Promise<string> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Cannot refresh OAuth token: SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required');
    }

    logger.info('Refreshing Shopify OAuth token via client credentials flow');
    const response = await fetch(`https://${this.storeDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Shopify OAuth token exchange failed (HTTP ${response.status}): ${body.slice(0, 500)}`);
    }

    const data = await response.json() as { access_token: string; expires_in?: number };
    const expiresInSec = data.expires_in ?? 86400;
    // Refresh 5 minutes before actual expiry
    this.oauthExpiresAt = Date.now() + (expiresInSec - 300) * 1000;
    this.oauthToken = data.access_token;

    logger.info('Shopify OAuth token refreshed', { expiresInSec });
    return data.access_token;
  }

  /**
   * Ensure headers use a fresh access token. If client credentials are
   * configured, use OAuth; otherwise fall back to the static token.
   */
  private async ensureAuth(): Promise<void> {
    if (!this.clientId || !this.clientSecret) {
      // Static token mode — nothing to do
      return;
    }
    if (this.oauthToken && Date.now() < this.oauthExpiresAt) {
      // Token still valid
      this.headers['X-Shopify-Access-Token'] = this.oauthToken;
      return;
    }
    const token = await this.refreshOAuthToken();
    this.headers['X-Shopify-Access-Token'] = token;
  }

  private async gql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    await this.ensureAuth();
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Shopify GraphQL HTTP ${response.status}: ${body.slice(0, 500)}`
      );
    }

    const json = (await response.json()) as GqlResponse;

    if (json.errors && json.errors.length > 0) {
      const messages = json.errors.map((e) => e.message).join('; ');
      throw new Error(`Shopify GraphQL errors: ${messages}`);
    }

    return json as T;
  }

  // ─── REST helper ────────────────────────────────────────────────────────────

  private async rest<T>(path: string, body: unknown, method: string = 'POST'): Promise<T> {
    await this.ensureAuth();
    const response = await fetch(`${this.restBaseUrl}${path}`, {
      method,
      headers: this.headers,
      body:    JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Shopify REST ${response.status} ${path}: ${text.slice(0, 500)}`);
    }
    return response.json() as Promise<T>;
  }

  private async restGet<T>(path: string): Promise<T> {
    await this.ensureAuth();
    const response = await fetch(`${this.restBaseUrl}${path}`, {
      method:  'GET',
      headers: this.headers,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Shopify REST GET ${response.status} ${path}: ${text.slice(0, 500)}`);
    }
    return response.json() as Promise<T>;
  }

  // ─── Fetch a Shopify order by ID (REST) ──────────────────────────────────

  async getOrderById(orderId: number): Promise<{
    id: number;
    name: string;
    note: string | null;
    tags: string;
    line_items: Array<{ id: number; sku: string; variant_id: number; quantity: number; name: string }>;
  }> {
    const result = await this.restGet<{ order: {
      id: number; name: string; note: string | null; tags: string;
      line_items: Array<{ id: number; sku: string; variant_id: number; quantity: number; name: string }>;
    } }>(`/orders/${orderId}.json`);
    return result.order;
  }

  // ─── Inventory item → SKU lookup (for stock webhooks) ───────────────────────

  async lookupSkuByInventoryItem(inventoryItemId: number): Promise<string | null> {
    const gid = `gid://shopify/InventoryItem/${inventoryItemId}`;
    const query = `
      query LookupInventoryItem($id: ID!) {
        inventoryItem(id: $id) { sku }
      }
    `;
    const result = await this.gql<{ data?: { inventoryItem?: { sku: string } | null } }>(
      query, { id: gid }
    );
    return result.data?.inventoryItem?.sku ?? null;
  }

  // ─── SKU → numeric variant ID lookup (for order creation) ──────────────────

  async lookupVariantIdBySku(sku: string): Promise<string | null> {
    const query = `
      query LookupVariantBySku($q: String!) {
        productVariants(first: 1, query: $q) {
          edges { node { id sku } }
        }
      }
    `;
    const result = await this.gql<{
      data?: { productVariants: { edges: Array<{ node: { id: string; sku: string } }> } };
    }>(query, { q: `sku:${sku}` });
    const edge = result.data?.productVariants.edges[0];
    return edge ? numericId(edge.node.id) : null;
  }

  // ─── Create a Shopify order from a Mirakl sale ──────────────────────────────

  async createOrderFromMirakl(order: MiraklOrder): Promise<{ id: number; name: string }> {
    // Resolve ALL offer SKUs to Shopify variant IDs.
    // We reject the entire order if any line item fails to resolve —
    // partial orders are worse than no order (customer gets incomplete shipment).
    const failedSkus: string[] = [];
    const lineItems: Array<{ variant_id: number; quantity: number }> = [];

    for (const line of order.order_lines) {
      const variantId = await this.lookupVariantIdBySku(line.offer_sku);
      if (!variantId) {
        failedSkus.push(line.offer_sku);
        continue;
      }
      lineItems.push({ variant_id: Number(variantId), quantity: line.quantity });
    }

    if (failedSkus.length > 0) {
      throw new Error(
        `Cannot create Shopify order for Mirakl ${order.order_id}: ` +
        `${failedSkus.length}/${order.order_lines.length} SKUs not found: ${failedSkus.join(', ')}`
      );
    }

    if (lineItems.length === 0) {
      throw new Error(`No line items in Mirakl order ${order.order_id}`);
    }

    // Mirakl nests addresses inside customer object, NOT at top level
    const addr = order.customer?.shipping_address ?? order.shipping_address;
    const bill = order.customer?.billing_address ?? order.billing_address;
    const email = order.customer_notification_email
      ?? order.customer?.email ?? addr?.email ?? bill?.email ?? '';

    // Build address objects with null-safe access — Mirakl can omit these entirely
    const shippingAddress = addr ? {
      first_name:   addr.firstname ?? '',
      last_name:    addr.lastname ?? '',
      address1:     addr.street_1 ?? '',
      address2:     addr.street_2 ?? '',
      city:         addr.city ?? '',
      zip:          addr.zip_code ?? '',
      country_code: addr.country ?? addr.country_iso_code ?? 'GB',
      phone:        addr.phone ?? '',
    } : undefined;

    const billingAddress = bill ? {
      first_name:   bill.firstname ?? '',
      last_name:    bill.lastname ?? '',
      address1:     bill.street_1 ?? '',
      address2:     bill.street_2 ?? '',
      city:         bill.city ?? '',
      zip:          bill.zip_code ?? '',
      country_code: bill.country ?? bill.country_iso_code ?? 'GB',
      phone:        bill.phone ?? '',
    } : shippingAddress; // Fall back to shipping if billing missing

    // Customer name from the customer object or fall back to address
    const customerFirstName = order.customer?.firstname ?? addr?.firstname ?? '';
    const customerLastName  = order.customer?.lastname ?? addr?.lastname ?? '';

    // Calculate order total for the external payment transaction
    const orderTotal = order.total_price
      ?? order.order_lines.reduce((sum, li) => sum + li.price * li.quantity, 0);

    const payload = {
      order: {
        line_items:       lineItems,
        email,
        ...(shippingAddress && { shipping_address: shippingAddress }),
        ...(billingAddress  && { billing_address:  billingAddress }),
        customer: {
          first_name: customerFirstName,
          last_name:  customerLastName,
          email:      email || undefined,
        },
        financial_status:           'paid',
        inventory_behaviour:        'decrement_ignoring_policy',
        send_receipt:               false,
        send_fulfillment_receipt:   true,
        source_name:  'Debenhams',
        tags:         'mirakl,debenhams',
        note:         `Mirakl order: ${order.order_id} | Debenhams marketplace`,
        shipping_lines: [{
          title:  'Standard Delivery (Debenhams)',
          price:  '0.00',
          code:   'debenhams_standard',
        }],
        transactions: [{
          kind:     'sale',
          status:   'success',
          amount:   orderTotal.toFixed(2),
          gateway:  'Debenhams Marketplace',
        }],
      },
    };

    const result = await this.rest<{ order: { id: number; name: string } }>(
      '/orders.json',
      payload
    );
    return result.order;
  }

  // ─── Fetch all inventory levels by SKU (for reconciliation) ────────────────

  async fetchAllInventoryLevels(): Promise<Map<string, number>> {
    const all = await this.fetchAllInventoryAndPrices();
    const levels = new Map<string, number>();
    for (const [sku, data] of all) {
      levels.set(sku, data.quantity);
    }
    return levels;
  }

  /**
   * Fetch all variant inventory levels AND prices in a single pass.
   * Returns Map<sku, { quantity, price, compareAtPrice }>.
   */
  async fetchAllInventoryAndPrices(): Promise<Map<string, { quantity: number; price: string; compareAtPrice: string | null }>> {
    interface InventoryPriceResponse {
      data?: {
        productVariants: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          edges: Array<{ node: { sku: string; inventoryQuantity: number; price: string; compareAtPrice: string | null } }>;
        };
      };
    }

    const results = new Map<string, { quantity: number; price: string; compareAtPrice: string | null }>();
    let cursor: string | null = null;

    const QUERY = `
      query GetInventoryAndPrices($cursor: String) {
        productVariants(first: 100, after: $cursor, query: "inventory_quantity:>=0") {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              sku
              inventoryQuantity
              price
              compareAtPrice
            }
          }
        }
      }
    `;

    do {
      const result: InventoryPriceResponse = await this.gql<InventoryPriceResponse>(QUERY, { cursor });

      const variants = result.data?.productVariants;
      if (!variants) break;

      for (const edge of variants.edges) {
        const { sku, inventoryQuantity, price, compareAtPrice } = edge.node;
        if (sku) results.set(sku, { quantity: inventoryQuantity, price, compareAtPrice: compareAtPrice ?? null });
      }

      cursor = variants.pageInfo.hasNextPage ? variants.pageInfo.endCursor : null;
    } while (cursor);

    return results;
  }

  /**
   * Bulk-update variant barcodes for a single product.
   * Uses productVariantsBulkUpdate (productVariantUpdate was removed in 2024-01+).
   * @param productGid  The product's GraphQL ID (gid://shopify/Product/...)
   * @param updates     Array of { variantGid, barcode } pairs
   */
  async updateVariantBarcodes(
    productGid: string,
    updates: Array<{ variantGid: string; barcode: string }>
  ): Promise<void> {
    const mutation = `
      mutation UpdateVariantBarcodes($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id barcode }
          userErrors { field message }
        }
      }
    `;
    const result = await this.gql<{
      data?: {
        productVariantsBulkUpdate: {
          productVariants: Array<{ id: string; barcode: string }> | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };
    }>(mutation, {
      productId: productGid,
      variants: updates.map(u => ({ id: u.variantGid, barcode: u.barcode })),
    });

    const errors = result.data?.productVariantsBulkUpdate?.userErrors;
    if (errors && errors.length > 0) {
      throw new Error(errors.map(e => e.message).join('; '));
    }
  }

  /**
   * Fetch all active products.
   * @param since  Optional ISO timestamp — only return products updated after this date (incremental).
   */
  async fetchAllProducts(since?: string): Promise<ShopifyProduct[]> {
    const products: ShopifyProduct[] = [];
    let cursor: string | null = null;
    let page = 0;

    // Build Shopify search query
    const queryParts: string[] = ['status:active'];
    if (since) {
      // Shopify accepts: updated_at:>'2024-01-01T00:00:00Z'
      queryParts.push(`updated_at:>'${since}'`);
    }
    const shopifyQuery = queryParts.join(' AND ');

    logger.info('Fetching products from Shopify', {
      query: shopifyQuery,
      incremental: !!since,
    });

    do {
      page++;
      const gqlResult: GqlResponse = await this.gql<GqlResponse>(PRODUCTS_QUERY, {
        cursor,
        query: shopifyQuery,
      });

      const data = gqlResult.data?.products;
      if (!data) {
        throw new Error('Unexpected empty response from Shopify products query');
      }

      const batch = data.edges.map((e: { node: GqlProductNode }) => normaliseProduct(e.node));
      products.push(...batch);

      logger.info(`Shopify page ${page}: +${batch.length} products (running total: ${products.length})`);

      cursor = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
    } while (cursor !== null);

    logger.info(`Shopify fetch complete: ${products.length} active products`);
    return products;
  }
}
