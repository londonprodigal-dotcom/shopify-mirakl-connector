import { AppConfig } from './config';
import { ShopifyProduct, ShopifyVariant, ShopifyImage } from './types';
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
  private readonly headers: Record<string, string>;

  constructor(config: AppConfig) {
    this.endpoint = config.shopify.graphqlEndpoint;
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

      logger.debug(`Shopify page ${page}: fetched ${batch.length} products (total: ${products.length})`);

      cursor = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
    } while (cursor !== null);

    logger.info(`Shopify fetch complete: ${products.length} active products`);
    return products;
  }
}
