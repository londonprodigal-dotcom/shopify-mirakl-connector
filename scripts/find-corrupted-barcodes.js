/**
 * Find Shopify variants with corrupted barcodes (scientific notation / invalid)
 * and try to match them to GS1 records by SKU.
 * READ-ONLY.
 */
const fs = require('fs');
const path = require('path');

const CLIENT_ID = '518104b0e8cc61381f290cc656b77859';
const CLIENT_SECRET = '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';
const SHOP = 'louchelondon.myshopify.com';

const GS1_FILES = [
  path.resolve(__dirname, '../../Downloads/GTIN13-50554830-EN-0A8E-A627-41CE.csv'),
  path.resolve(__dirname, '../../Downloads/GTIN13-50560020-EN-56A7-EFCD-4777.csv'),
  path.resolve(__dirname, '../../Downloads/GTIN13-50562694-EN-2DB5-BB86-4149.csv'),
  path.resolve(__dirname, '../../Downloads/GTIN13-50563823-EN-F2F1-3A36-410C.csv'),
  path.resolve(__dirname, '../../Downloads/GTIN13-50566951-EN-A0C8-E667-422F.csv'),
];

function parseGS1(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const records = [];
  for (let i = 4; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const match = line.match(/^"=""(\d+)""",(\w+),(.*)/);
    if (!match) continue;
    const [, ean, status, rest] = match;
    const desc = rest.split(',')[0].trim();
    records.push({ ean, desc });
  }
  return records;
}

function norm(s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }

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
        id: e.node.id, title: e.node.title,
        variants: e.node.variants.edges.map(ve => ({
          id: ve.node.id, sku: ve.node.sku, barcode: ve.node.barcode, title: ve.node.title,
        })),
      });
    }
    cursor = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

function csvEscape(s) {
  if (s == null) return '';
  s = String(s);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

(async function () {
  // Load GS1
  let allRecords = [];
  for (const f of GS1_FILES) allRecords = allRecords.concat(parseGS1(f));
  const gs1ByNorm = new Map();
  for (const r of allRecords) {
    const key = norm(r.desc);
    if (!gs1ByNorm.has(key)) gs1ByNorm.set(key, []);
    gs1ByNorm.get(key).push(r);
  }
  console.log(`GS1 records: ${allRecords.length}`);

  // Fetch Shopify
  console.log('Fetching Shopify...');
  const token = await getAccessToken();
  const products = await fetchAllProducts(token);

  // Find corrupted barcodes
  const rows = [];
  for (const p of products) {
    for (const v of p.variants) {
      const bc = v.barcode?.trim() || '';
      if (!bc) continue;

      const isCorrupted = bc.includes('E+') || bc.includes('e+') || bc.includes('.') || !/^\d{8}$|^\d{12}$|^\d{13}$/.test(bc);
      if (!isCorrupted) continue;

      const sku = v.sku?.trim() || '';
      let gs1Ean = '';
      let gs1Desc = '';
      let matchType = '';

      if (sku) {
        const hits = gs1ByNorm.get(norm(sku));
        if (hits) {
          const uniqueEans = [...new Set(hits.map(h => h.ean))];
          if (uniqueEans.length === 1) {
            gs1Ean = uniqueEans[0];
            gs1Desc = hits[0].desc;
            matchType = 'EXACT_MATCH';
          } else {
            gs1Ean = uniqueEans.join(' | ');
            gs1Desc = hits[0].desc;
            matchType = 'AMBIGUOUS';
          }
        } else {
          matchType = 'NO_GS1_MATCH';
        }
      } else {
        matchType = 'NO_SKU';
      }

      rows.push({
        productTitle: p.title,
        variant: v.title,
        sku,
        corruptedBarcode: bc,
        matchType,
        gs1Ean,
        gs1Desc,
        variantGid: v.id,
        productGid: p.id,
      });
    }
  }

  // Sort: matches first
  const order = { EXACT_MATCH: 0, AMBIGUOUS: 1, NO_GS1_MATCH: 2, NO_SKU: 3 };
  rows.sort((a, b) => (order[a.matchType] ?? 99) - (order[b.matchType] ?? 99));

  // Write CSV
  const header = 'match_type,shopify_product,shopify_variant,sku,corrupted_barcode,correct_ean,gs1_description,variant_gid';
  const csvRows = rows.map(r =>
    [r.matchType, r.productTitle, r.variant, r.sku, r.corruptedBarcode, r.gs1Ean, r.gs1Desc, r.variantGid]
      .map(csvEscape).join(',')
  );

  const outPath = path.resolve(__dirname, '../../Downloads/corrupted-barcodes.csv');
  fs.writeFileSync(outPath, [header, ...csvRows].join('\n'), 'utf8');

  // Summary
  const counts = {};
  for (const r of rows) counts[r.matchType] = (counts[r.matchType] || 0) + 1;
  console.log(`\nCorrupted barcodes found: ${rows.length}`);
  for (const [t, c] of Object.entries(counts)) {
    console.log(`  ${t.padEnd(20)} ${c}`);
  }

  const fixable = counts['EXACT_MATCH'] || 0;
  console.log(`\nFixable (exact GS1 match): ${fixable}`);
  console.log(`CSV: ${outPath}`);
})();
