/**
 * Simple, clear CSV of all variants that need EANs.
 * Two sections:
 *   1. Has SKU, no EAN — just register existing SKU in GS1
 *   2. No SKU, no EAN — needs SKU created first, then register in GS1
 *
 * READ-ONLY.
 */
const fs = require('fs');
const path = require('path');

const CLIENT_ID = '518104b0e8cc61381f290cc656b77859';
const CLIENT_SECRET = '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';
const SHOP = 'louchelondon.myshopify.com';

const EXCLUDE = [/gift\s*card/i, /gift\s*voucher/i, /e-?gift/i, /bundle/i, /sample/i, /swatch/i, /shipping/i, /delivery/i, /postage/i];

async function getAccessToken() {
  const resp = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  return (await resp.json()).access_token;
}

async function fetchAllProducts(token) {
  const QUERY = `
    query GetProducts($cursor: String) {
      products(first: 50, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id title
          variants(first: 100) { edges { node {
            id sku barcode title
            selectedOptions { name value }
          } } }
        } }
      }
    }
  `;
  const products = [];
  let cursor = null;
  do {
    const resp = await fetch(`https://${SHOP}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: QUERY, variables: { cursor } }),
    });
    const json = await resp.json();
    const data = json.data.products;
    for (const e of data.edges) {
      products.push({
        title: e.node.title,
        variants: e.node.variants.edges.map(ve => ({
          sku: ve.node.sku, barcode: ve.node.barcode, title: ve.node.title,
          selectedOptions: ve.node.selectedOptions,
        })),
      });
    }
    cursor = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

function getOption(variant, name) {
  for (const opt of (variant.selectedOptions || [])) {
    if (opt.name.toLowerCase() === name.toLowerCase()) return opt.value;
  }
  return '';
}

function csvEscape(s) {
  if (s == null) return '';
  s = String(s);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

(async function () {
  console.log('Fetching Shopify...');
  const token = await getAccessToken();
  const products = await fetchAllProducts(token);
  console.log(`Products: ${products.length}`);

  const rows = [];
  let excluded = 0, withBarcode = 0;

  for (const p of products) {
    if (EXCLUDE.some(rx => rx.test(p.title))) { excluded++; continue; }

    for (const v of p.variants) {
      if (v.barcode?.trim()) { withBarcode++; continue; }

      const sku = v.sku?.trim() || '';
      const colour = getOption(v, 'Color') || getOption(v, 'Colour') || getOption(v, 'Color/Pattern') || '';
      const size = getOption(v, 'Size') || v.title || '';

      rows.push({
        status: sku ? 'HAS_SKU_NEEDS_EAN' : 'NEEDS_SKU_AND_EAN',
        productTitle: p.title,
        variant: v.title,
        currentSku: sku,
        colour,
        size,
      });
    }
  }

  // Sort: NEEDS_SKU first, then HAS_SKU, alphabetical by product within each
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'NEEDS_SKU_AND_EAN' ? -1 : 1;
    return a.productTitle.localeCompare(b.productTitle) || a.size.localeCompare(b.size);
  });

  // Write CSV
  const header = 'status,shopify_product_title,shopify_variant,current_sku,colour,size';
  const csvRows = rows.map(r =>
    [r.status, r.productTitle, r.variant, r.currentSku, r.colour, r.size].map(csvEscape).join(',')
  );

  const outPath = path.resolve(__dirname, '../../Downloads/ean-needed.csv');
  fs.writeFileSync(outPath, [header, ...csvRows].join('\n'), 'utf8');

  // Summary
  const needsSku = rows.filter(r => r.status === 'NEEDS_SKU_AND_EAN').length;
  const hasSku = rows.filter(r => r.status === 'HAS_SKU_NEEDS_EAN').length;

  console.log(`\nAlready have barcode: ${withBarcode}`);
  console.log(`Excluded (gift cards etc): ${excluded} products`);
  console.log(`\nNeed EAN registration:`);
  console.log(`  HAS_SKU_NEEDS_EAN:    ${hasSku} (just register existing SKU in GS1)`);
  console.log(`  NEEDS_SKU_AND_EAN:    ${needsSku} (need SKU created first)`);
  console.log(`  Total:                ${rows.length}`);
  console.log(`\nCSV: ${outPath}`);
})();
