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
          images(first: 10) {
            edges {
              node {
                url
                altText
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
                weight
                weightUnit
                inventoryQuantity
                selectedOptions {
                  name
                  value
                }
                image {
                  url
                  altText
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
  weight: number;
  weightUnit: string;
  inventoryQuantity: number;
  selectedOptions: Array<{ name: string; value: string }>;
  image: { url: string; altText: string | null } | null;
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
  images: { edges: Array<{ node: { url: string; altText: string | null } }> };
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
    barcode: raw.barcode && raw.barcode.trim() !== '' ? raw.barcode.trim() : null,
    weight: raw.weight ?? 0,
    weightUnit: raw.weightUnit ?? 'KILOGRAMS',
    inventoryQuantity: raw.inventoryQuantity ?? 0,
    selectedOptions: raw.selectedOptions ?? [],
    image: raw.image ?? null,
  };
}

function normaliseProduct(raw: GqlProductNode): ShopifyProduct {
  const images: ShopifyImage[] = raw.images.edges.map((e) => ({
    url: e.node.url,
    altText: e.node.altText,
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
  private readonly headers: Record<string, string>;

  constructor(config: AppConfig) {
    this.endpoint    = config.shopify.graphqlEndpoint;
    this.restBaseUrl = config.shopify.restBaseUrl;
    this.headers = {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.shopify.adminAccessToken,
    };
  }

  private async gql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
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

  private async rest<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.restBaseUrl}${path}`, {
      method:  'POST',
      headers: this.headers,
      body:    JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Shopify REST ${response.status} ${path}: ${text.slice(0, 500)}`);
    }
    return response.json() as Promise<T>;
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
    // Resolve all offer SKUs to Shopify numeric variant IDs
    const lineItems = (
      await Promise.all(
        order.order_lines.map(async (line) => {
          const variantId = await this.lookupVariantIdBySku(line.offer_sku);
          if (!variantId) {
            logger.warn('No variant found for SKU — skipping line', { sku: line.offer_sku });
            return null;
          }
          return { variant_id: Number(variantId), quantity: line.quantity };
        })
      )
    ).filter((l): l is { variant_id: number; quantity: number } => l !== null);

    if (lineItems.length === 0) {
      throw new Error(`No Shopify variants matched for Mirakl order ${order.order_id}`);
    }

    const addr = order.shipping_address;
    const bill = order.billing_address;
    const email = order.customer.email ?? addr.email ?? bill.email ?? '';

    const payload = {
      order: {
        line_items:       lineItems,
        email,
        shipping_address: {
          first_name: addr.firstname,
          last_name:  addr.lastname,
          address1:   addr.street_1,
          address2:   addr.street_2 ?? '',
          city:       addr.city,
          zip:        addr.zip_code,
          country_code: addr.country ?? addr.country_iso_code ?? 'GB',
          phone:      addr.phone ?? '',
        },
        billing_address: {
          first_name: bill.firstname,
          last_name:  bill.lastname,
          address1:   bill.street_1,
          address2:   bill.street_2 ?? '',
          city:       bill.city,
          zip:        bill.zip_code,
          country_code: bill.country ?? bill.country_iso_code ?? 'GB',
          phone:      bill.phone ?? '',
        },
        financial_status:           'paid',
        inventory_behaviour:        'decrement_ignoring_policy',
        send_receipt:               false,
        send_fulfillment_receipt:   false,
        tags:   'mirakl,debenhams',
        note:   `Mirakl order: ${order.order_id}`,
      },
    };

    const result = await this.rest<{ order: { id: number; name: string } }>(
      '/orders.json',
      payload
    );
    return result.order;
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
