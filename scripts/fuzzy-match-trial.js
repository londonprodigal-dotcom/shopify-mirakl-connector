/**
 * Trial fuzzy match: find Shopify variants without barcodes and attempt
 * fuzzy matching against GS1 descriptions.
 * READ-ONLY — no changes made.
 */
const fs = require('fs');
const path = require('path');
const { CLIENT_ID, CLIENT_SECRET, SHOP, getAccessToken } = require('./shopify-auth');

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

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Levenshtein distance
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

// Split SKU into parts: name, colour, size
function parseSku(sku) {
  // Format: NAME-FABRIC_COLOUR_SIZE or NAME-COLOUR_SIZE
  const underscoreIdx = sku.lastIndexOf('_');
  if (underscoreIdx === -1) return { base: sku, size: null };
  const size = sku.substring(underscoreIdx + 1);
  const base = sku.substring(0, underscoreIdx);
  return { base, size };
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
          id: ve.node.id,
          sku: ve.node.sku,
          barcode: ve.node.barcode,
          title: ve.node.title,
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

  // Build GS1 lookup by normalised description
  const gs1ByNorm = new Map();
  for (const r of allRecords) {
    const key = norm(r.desc);
    if (!gs1ByNorm.has(key)) gs1ByNorm.set(key, []);
    gs1ByNorm.get(key).push(r);
  }

  // Also build a list of all GS1 base names (without size suffix) for fuzzy matching
  const gs1Bases = new Map(); // norm(base) -> [{ean, desc, size, normFull}]
  for (const r of allRecords) {
    const parsed = parseSku(r.desc);
    const baseKey = norm(parsed.base);
    if (!gs1Bases.has(baseKey)) gs1Bases.set(baseKey, []);
    gs1Bases.get(baseKey).push({ ...r, size: parsed.size, normFull: norm(r.desc) });
  }
  const gs1BaseKeys = [...gs1Bases.keys()];

  console.log(`GS1 records: ${allRecords.length}, unique bases: ${gs1Bases.size}`);

  // Fetch Shopify
  console.log('Fetching Shopify products...');
  const token = await getAccessToken();
  const products = await fetchAllProducts(token);

  // Find variants without barcodes
  const missing = [];
  let withBarcode = 0, noSku = 0;
  for (const p of products) {
    for (const v of p.variants) {
      if (v.barcode?.trim()) { withBarcode++; continue; }
      if (!v.sku?.trim()) { noSku++; continue; }
      missing.push({
        productTitle: p.title,
        variantTitle: v.title,
        sku: v.sku.trim(),
      });
    }
  }

  console.log(`\nVariants with barcode: ${withBarcode}`);
  console.log(`Variants without barcode (have SKU): ${missing.length}`);
  console.log(`Variants without SKU: ${noSku}`);

  // Group missing by product for cleaner output
  const byProduct = new Map();
  for (const m of missing) {
    if (!byProduct.has(m.productTitle)) byProduct.set(m.productTitle, []);
    byProduct.get(m.productTitle).push(m);
  }

  console.log(`\nProducts missing barcodes: ${byProduct.size}`);
  console.log(`\n${'='.repeat(100)}`);
  console.log('FUZZY MATCH TRIAL — showing closest GS1 matches for each missing SKU');
  console.log('$'.repeat(100));

  const results = [];

  for (const [productTitle, variants] of byProduct) {
    for (const v of variants) {
      const skuNorm = norm(v.sku);
      const skuParsed = parseSku(v.sku);
      const skuBaseNorm = norm(skuParsed.base);

      // 1. Exact match (should be none since we already applied those)
      const exact = gs1ByNorm.get(skuNorm);
      if (exact) {
        results.push({
          type: 'EXACT',
          productTitle,
          variantTitle: v.variantTitle,
          sku: v.sku,
          gs1Desc: exact[0].desc,
          ean: exact[0].ean,
          distance: 0,
        });
        continue;
      }

      // 2. Base match (same base, different or missing size)
      const baseHits = gs1Bases.get(skuBaseNorm);
      if (baseHits) {
        // Find one with matching size
        const sizeMatch = baseHits.find(h => h.size === skuParsed.size);
        if (sizeMatch) {
          results.push({
            type: 'BASE+SIZE',
            productTitle,
            variantTitle: v.variantTitle,
            sku: v.sku,
            gs1Desc: sizeMatch.desc,
            ean: sizeMatch.ean,
            distance: 0,
          });
          continue;
        }
        // Show closest size
        results.push({
          type: 'BASE_ONLY',
          productTitle,
          variantTitle: v.variantTitle,
          sku: v.sku,
          gs1Desc: baseHits[0].desc,
          ean: baseHits[0].ean,
          note: `Base matches but size differs. SKU size="${skuParsed.size}", GS1 sizes: ${[...new Set(baseHits.map(h=>h.size))].join(', ')}`,
          distance: 1,
        });
        continue;
      }

      // 3. Fuzzy match on base — find closest by levenshtein
      let bestDist = Infinity;
      let bestKey = null;
      for (const gKey of gs1BaseKeys) {
        // Quick filter: skip if length difference is too big
        if (Math.abs(gKey.length - skuBaseNorm.length) > 10) continue;
        const d = levenshtein(skuBaseNorm, gKey);
        if (d < bestDist) {
          bestDist = d;
          bestKey = gKey;
        }
      }

      const similarity = bestKey ? (1 - bestDist / Math.max(skuBaseNorm.length, bestKey.length)) : 0;

      if (bestKey && similarity >= 0.6) {
        const bestHits = gs1Bases.get(bestKey);
        results.push({
          type: 'FUZZY',
          productTitle,
          variantTitle: v.variantTitle,
          sku: v.sku,
          gs1Desc: bestHits[0].desc,
          ean: bestHits[0].ean,
          distance: bestDist,
          similarity: (similarity * 100).toFixed(1) + '%',
          note: `Levenshtein distance ${bestDist}, similarity ${(similarity * 100).toFixed(1)}%`,
        });
      } else {
        results.push({
          type: 'NO_MATCH',
          productTitle,
          variantTitle: v.variantTitle,
          sku: v.sku,
          gs1Desc: bestKey ? gs1Bases.get(bestKey)[0].desc : '(none)',
          distance: bestDist,
          similarity: bestKey ? (similarity * 100).toFixed(1) + '%' : '0%',
        });
      }
    }
  }

  // Sort by type priority
  const typeOrder = { 'EXACT': 0, 'BASE+SIZE': 1, 'BASE_ONLY': 2, 'FUZZY': 3, 'NO_MATCH': 4 };
  results.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);

  // Print grouped by type
  const grouped = {};
  for (const r of results) {
    if (!grouped[r.type]) grouped[r.type] = [];
    grouped[r.type].push(r);
  }

  for (const [type, items] of Object.entries(grouped)) {
    console.log(`\n${'─'.repeat(100)}`);
    console.log(`${type} (${items.length} variants)`);
    console.log(`${'─'.repeat(100)}`);

    for (const r of items.slice(0, 50)) {
      console.log(`  SKU: ${r.sku}`);
      console.log(`    Product: ${r.productTitle} / ${r.variantTitle}`);
      console.log(`    GS1:     ${r.gs1Desc} → EAN ${r.ean}`);
      if (r.note) console.log(`    Note:    ${r.note}`);
      if (r.similarity) console.log(`    Similarity: ${r.similarity}`);
      console.log('');
    }
    if (items.length > 50) {
      console.log(`  ... and ${items.length - 50} more`);
    }
  }

  // Summary
  console.log(`\n${'='.repeat(100)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(100)}`);
  console.log(`  Already have barcode:  ${withBarcode}`);
  console.log(`  Missing barcode (with SKU): ${missing.length}`);
  console.log(`  No SKU at all:         ${noSku}`);
  console.log('');
  for (const [type, items] of Object.entries(grouped)) {
    console.log(`  ${type.padEnd(15)} ${items.length}`);
  }
  console.log(`${'='.repeat(100)}`);
})();
