/**
 * Read-only: list all sale-related collections on Louche with their filter
 * rules (manual vs automated, and if automated, the rules used). Tells us
 * whether markdown variants lacking the `sale` tag appear to customers on
 * louchelondon.com.
 */

import { loadConfig } from '../config';
import { ShopifyClient } from '../shopifyClient';

interface Rule {
  column: string;
  relation: string;
  condition: string;
}
interface CollectionNode {
  id: string;
  title: string;
  handle: string;
  productsCount: { count: number };
  ruleSet: null | {
    appliedDisjunctively: boolean;
    rules: Rule[];
  };
}
interface Resp {
  data?: {
    collections: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: CollectionNode }>;
    };
  };
}

export async function checkLoucheSaleCollections(): Promise<void> {
  const config = loadConfig();
  const shopify = new ShopifyClient(config);
  const gql = shopify as unknown as { gql: <T>(q: string, v: Record<string, unknown>) => Promise<T> };

  const QUERY = `
    query C($cursor: String) {
      collections(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            productsCount { count }
            ruleSet {
              appliedDisjunctively
              rules { column relation condition }
            }
          }
        }
      }
    }
  `;

  const collections: CollectionNode[] = [];
  let cursor: string | null = null;
  do {
    const r: Resp = await gql.gql<Resp>(QUERY, { cursor });
    const cs = r.data?.collections;
    if (!cs) break;
    for (const e of cs.edges) collections.push(e.node);
    cursor = cs.pageInfo.hasNextPage ? cs.pageInfo.endCursor : null;
  } while (cursor);

  // Filter to sale-related by handle or title keyword
  const SALE_RE = /sale|clearance|markdown|reduction|outlet|last.?chance/i;
  const relevant = collections.filter(c => SALE_RE.test(c.handle) || SALE_RE.test(c.title));

  process.stdout.write(`total_collections=${collections.length}\n`);
  process.stdout.write(`sale_related=${relevant.length}\n\n`);

  for (const c of relevant) {
    const mode = c.ruleSet ? 'AUTOMATED' : 'MANUAL';
    const count = c.productsCount?.count ?? 0;
    process.stdout.write(`──────────────────────────────────────\n`);
    process.stdout.write(`/${c.handle}  →  ${c.title}  (${count} products, ${mode})\n`);
    if (c.ruleSet) {
      process.stdout.write(`  match: ${c.ruleSet.appliedDisjunctively ? 'ANY rule' : 'ALL rules'}\n`);
      for (const rule of c.ruleSet.rules) {
        process.stdout.write(`  rule: ${rule.column} ${rule.relation} "${rule.condition}"\n`);
      }
    } else {
      process.stdout.write(`  (manual curation — operator adds products individually)\n`);
    }
  }

  if (relevant.length === 0) {
    process.stdout.write('No sale-related collections found on Louche.\n');
  }
}
