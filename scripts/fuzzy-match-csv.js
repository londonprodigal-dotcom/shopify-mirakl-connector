/**
 * Export fuzzy match trial to CSV for review.
 * Columns: match_type, shopify_product, shopify_variant, shopify_sku, gs1_description, gs1_ean, similarity, note
 * READ-ONLY — no changes made.
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

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
    }
  }
  return dp[m][n];
}

function parseSku(sku) {
  const idx = sku.lastIndexOf('_');
  if (idx === -1) return { base: sku, size: null };
  return { base: sku.substring(0, idx), size: sku.substring(idx + 1) };
}

function csvEscape(s) {
  if (!s) return '';
  s = String(s);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

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
        id: e.node.id,
        title: e.node.title,
        variants: e.node.variants.edges.map(ve => ({
          id: ve.node.id, sku: ve.node.sku, barcode: ve.node.barcode, title: ve.node.title,
        })),
      });
    }
    cursor = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
  } while (cursor);
  return products;
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

  const gs1Bases = new Map();
  for (const r of allRecords) {
    const parsed = parseSku(r.desc);
    const baseKey = norm(parsed.base);
    if (!gs1Bases.has(baseKey)) gs1Bases.set(baseKey, []);
    gs1Bases.get(baseKey).push({ ...r, size: parsed.size });
  }
  const gs1BaseKeys = [...gs1Bases.keys()];

  console.log(`GS1 records: ${allRecords.length}`);

  // Fetch Shopify
  console.log('Fetching Shopify...');
  const token = await getAccessToken();
  const products = await fetchAllProducts(token);
  console.log(`Products: ${products.length}`);

  // Find variants without barcodes
  const rows = [];

  for (const p of products) {
    for (const v of p.variants) {
      if (v.barcode?.trim()) continue;
      const sku = v.sku?.trim();
      if (!sku) {
        rows.push({
          type: 'NO_SKU',
          shopifyProduct: p.title,
          shopifyVariant: v.title,
          shopifySku: '',
          gs1Desc: '',
          gs1Ean: '',
          gs1AllEans: '',
          similarity: '',
          note: 'No SKU on variant',
        });
        continue;
      }

      const skuNorm = norm(sku);
      const skuParsed = parseSku(sku);
      const skuBaseNorm = norm(skuParsed.base);

      // 1. Exact match
      const exact = gs1ByNorm.get(skuNorm);
      if (exact) {
        const uniqueEans = [...new Set(exact.map(h => h.ean))];
        if (uniqueEans.length === 1) {
          rows.push({
            type: 'EXACT',
            shopifyProduct: p.title,
            shopifyVariant: v.title,
            shopifySku: sku,
            gs1Desc: exact[0].desc,
            gs1Ean: exact[0].ean,
            gs1AllEans: exact[0].ean,
            similarity: '100%',
            note: 'Exact match, single EAN',
          });
        } else {
          rows.push({
            type: 'EXACT_AMBIGUOUS',
            shopifyProduct: p.title,
            shopifyVariant: v.title,
            shopifySku: sku,
            gs1Desc: exact[0].desc,
            gs1Ean: '',
            gs1AllEans: uniqueEans.join(' | '),
            similarity: '100%',
            note: `Exact SKU match but ${uniqueEans.length} different EANs in GS1`,
          });
        }
        continue;
      }

      // 2. Base match
      const baseHits = gs1Bases.get(skuBaseNorm);
      if (baseHits) {
        const sizeMatch = baseHits.find(h => h.size === skuParsed.size);
        if (sizeMatch) {
          const uniqueEans = [...new Set(baseHits.filter(h => h.size === skuParsed.size).map(h => h.ean))];
          rows.push({
            type: 'BASE_SIZE_MATCH',
            shopifyProduct: p.title,
            shopifyVariant: v.title,
            shopifySku: sku,
            gs1Desc: sizeMatch.desc,
            gs1Ean: uniqueEans.length === 1 ? sizeMatch.ean : '',
            gs1AllEans: uniqueEans.join(' | '),
            similarity: '100%',
            note: uniqueEans.length === 1 ? 'Base+size match' : `Base+size match but ${uniqueEans.length} EANs`,
          });
        } else {
          const availSizes = [...new Set(baseHits.map(h => h.size))].join(', ');
          rows.push({
            type: 'BASE_ONLY',
            shopifyProduct: p.title,
            shopifyVariant: v.title,
            shopifySku: sku,
            gs1Desc: baseHits[0].desc,
            gs1Ean: '',
            gs1AllEans: '',
            similarity: 'base match',
            note: `Base matches but size "${skuParsed.size}" not in GS1. Available: ${availSizes}`,
          });
        }
        continue;
      }

      // 3. Fuzzy match on base
      let bestDist = Infinity;
      let bestKey = null;
      for (const gKey of gs1BaseKeys) {
        if (Math.abs(gKey.length - skuBaseNorm.length) > 10) continue;
        const d = levenshtein(skuBaseNorm, gKey);
        if (d < bestDist) {
          bestDist = d;
          bestKey = gKey;
        }
      }

      const sim = bestKey ? (1 - bestDist / Math.max(skuBaseNorm.length, bestKey.length)) : 0;

      if (bestKey && sim >= 0.6) {
        const bestHits = gs1Bases.get(bestKey);
        // Try to find size match within fuzzy base
        const sizeMatch = bestHits.find(h => h.size === skuParsed.size);
        const bestMatch = sizeMatch || bestHits[0];
        rows.push({
          type: 'FUZZY',
          shopifyProduct: p.title,
          shopifyVariant: v.title,
          shopifySku: sku,
          gs1Desc: bestMatch.desc,
          gs1Ean: sizeMatch ? sizeMatch.ean : '',
          gs1AllEans: sizeMatch ? sizeMatch.ean : bestHits.slice(0, 3).map(h => h.ean + ' (' + h.desc + ')').join(' | '),
          similarity: (sim * 100).toFixed(1) + '%',
          note: sizeMatch
            ? `Fuzzy base match + size match (dist ${bestDist})`
            : `Fuzzy base match only (dist ${bestDist}). No size "${skuParsed.size}" in GS1`,
        });
      } else {
        rows.push({
          type: 'NO_MATCH',
          shopifyProduct: p.title,
          shopifyVariant: v.title,
          shopifySku: sku,
          gs1Desc: bestKey ? gs1Bases.get(bestKey)[0].desc : '',
          gs1Ean: '',
          gs1AllEans: '',
          similarity: bestKey ? (sim * 100).toFixed(1) + '%' : '0%',
          note: 'No close match in GS1',
        });
      }
    }
  }

  // Sort: EXACT first, then EXACT_AMBIGUOUS, BASE, FUZZY high→low, NO_MATCH, NO_SKU
  const typeOrder = { EXACT: 0, EXACT_AMBIGUOUS: 1, BASE_SIZE_MATCH: 2, BASE_ONLY: 3, FUZZY: 4, NO_MATCH: 5, NO_SKU: 6 };
  rows.sort((a, b) => {
    const to = typeOrder[a.type] - typeOrder[b.type];
    if (to !== 0) return to;
    // Within FUZZY, sort by similarity descending
    if (a.type === 'FUZZY') {
      return parseFloat(b.similarity) - parseFloat(a.similarity);
    }
    return 0;
  });

  // Write CSV
  const header = 'match_type,shopify_product_title,shopify_variant,shopify_sku,gs1_description,gs1_ean,gs1_all_eans,similarity,note';
  const csvRows = rows.map(r =>
    [r.type, r.shopifyProduct, r.shopifyVariant, r.shopifySku, r.gs1Desc, r.gs1Ean, r.gs1AllEans, r.similarity, r.note]
      .map(csvEscape).join(',')
  );

  const outPath = path.resolve(__dirname, '..', 'output', 'fuzzy-match-review.csv');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, [header, ...csvRows].join('\n'), 'utf8');

  // Summary
  const counts = {};
  for (const r of rows) counts[r.type] = (counts[r.type] || 0) + 1;
  console.log('\nSummary:');
  for (const [type, count] of Object.entries(counts)) {
    console.log(`  ${type.padEnd(20)} ${count}`);
  }
  console.log(`\nTotal: ${rows.length}`);
  console.log(`\nCSV: ${outPath}`);
})();
