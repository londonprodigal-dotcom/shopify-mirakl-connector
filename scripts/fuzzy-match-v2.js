/**
 * Fuzzy match v2 — cleaner logic, better CSV output.
 *
 * Key rules:
 * 1. Style name (first part of SKU) MUST match closely — different styles = NO MATCH
 * 2. Colour abbreviations are OK (M→MULTI, BW→BLK/WHT, etc.)
 * 3. Size must match exactly to assign a specific EAN
 * 4. If GS1 has multiple EANs for same base, pick the one with matching size
 * 5. If all GS1 entries share a description but have different EANs per size, match by size
 *
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

// Split SKU into style, rest, size
// e.g. "DAPHNE-CARPATHIAN-FLORALS-M_8" → { full, style: "DAPHNE", middle: "CARPATHIAN-FLORALS-M", size: "8" }
// e.g. "YASSINE-TICKING-STRIPES-WHITE&NAVY-08" → { full, style: "YASSINE", middle: "TICKING-STRIPES-WHITE&NAVY", size: "08" }
function parseSku(sku) {
  // Size is after last underscore or last hyphen if it looks like a number
  let size = null;
  let base = sku;

  // Try underscore first (standard format)
  const underIdx = sku.lastIndexOf('_');
  if (underIdx > 0) {
    const candidate = sku.substring(underIdx + 1);
    if (/^\d+$/.test(candidate) || candidate.toLowerCase() === 'os' || candidate.toLowerCase() === 'onesize') {
      size = candidate;
      base = sku.substring(0, underIdx);
    }
  }

  // If no underscore size, try last hyphen
  if (!size) {
    const hyphenIdx = sku.lastIndexOf('-');
    if (hyphenIdx > 0) {
      const candidate = sku.substring(hyphenIdx + 1);
      if (/^\d+$/.test(candidate)) {
        size = candidate;
        base = sku.substring(0, hyphenIdx);
      }
    }
  }

  // Extract style name (first segment before first hyphen)
  const firstHyphen = base.indexOf('-');
  const style = firstHyphen > 0 ? base.substring(0, firstHyphen) : base;
  const middle = firstHyphen > 0 ? base.substring(firstHyphen + 1) : '';

  return { full: sku, base, style, middle, size };
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

  // Index GS1 by normalised full description
  const gs1ByNorm = new Map();
  for (const r of allRecords) {
    const key = norm(r.desc);
    if (!gs1ByNorm.has(key)) gs1ByNorm.set(key, []);
    gs1ByNorm.get(key).push(r);
  }

  // Index GS1 by parsed base (without size)
  const gs1ByBase = new Map(); // norm(base) → [{ ean, desc, parsed }]
  const gs1ByStyle = new Map(); // norm(style) → [norm(base)]  for fuzzy style matching
  for (const r of allRecords) {
    const parsed = parseSku(r.desc);
    const baseKey = norm(parsed.base);
    if (!gs1ByBase.has(baseKey)) gs1ByBase.set(baseKey, []);
    gs1ByBase.get(baseKey).push({ ...r, parsed });

    const styleKey = norm(parsed.style);
    if (!gs1ByStyle.has(styleKey)) gs1ByStyle.set(styleKey, new Set());
    gs1ByStyle.get(styleKey).add(baseKey);
  }

  console.log(`GS1 records: ${allRecords.length}, unique bases: ${gs1ByBase.size}, unique styles: ${gs1ByStyle.size}`);

  // Fetch Shopify
  console.log('Fetching Shopify...');
  const token = await getAccessToken();
  const products = await fetchAllProducts(token);
  console.log(`Products: ${products.length}`);

  const rows = [];

  for (const p of products) {
    for (const v of p.variants) {
      if (v.barcode?.trim()) continue;
      const sku = v.sku?.trim();

      if (!sku) {
        rows.push({ type: 'NO_SKU', shopifyProduct: p.title, shopifyVariant: v.title,
          shopifySku: '', gs1Desc: '', gs1Ean: '', similarity: '', reason: 'No SKU on variant' });
        continue;
      }

      const skuParsed = parseSku(sku);
      const skuNorm = norm(sku);
      const skuBaseNorm = norm(skuParsed.base);
      const skuStyleNorm = norm(skuParsed.style);

      // 1. Exact full match
      const exact = gs1ByNorm.get(skuNorm);
      if (exact) {
        const uniqueEans = [...new Set(exact.map(h => h.ean))];
        if (uniqueEans.length === 1) {
          rows.push({ type: 'EXACT', shopifyProduct: p.title, shopifyVariant: v.title,
            shopifySku: sku, gs1Desc: exact[0].desc, gs1Ean: exact[0].ean,
            similarity: '100%', reason: 'Exact match - single EAN' });
        } else {
          rows.push({ type: 'EXACT_AMBIGUOUS', shopifyProduct: p.title, shopifyVariant: v.title,
            shopifySku: sku, gs1Desc: exact[0].desc, gs1Ean: uniqueEans.join(' | '),
            similarity: '100%', reason: `Exact SKU but ${uniqueEans.length} different EANs - needs manual pick` });
        }
        continue;
      }

      // 2. Exact base match — then find by size
      const baseHits = gs1ByBase.get(skuBaseNorm);
      if (baseHits) {
        const withSize = baseHits.filter(h => h.parsed.size === skuParsed.size);
        if (withSize.length > 0) {
          const uniqueEans = [...new Set(withSize.map(h => h.ean))];
          rows.push({ type: 'BASE_SIZE_MATCH', shopifyProduct: p.title, shopifyVariant: v.title,
            shopifySku: sku, gs1Desc: withSize[0].desc, gs1Ean: uniqueEans.length === 1 ? uniqueEans[0] : uniqueEans.join(' | '),
            similarity: '100%', reason: uniqueEans.length === 1 ? 'Base+size match' : `Base+size but ${uniqueEans.length} EANs` });
        } else {
          const availSizes = [...new Set(baseHits.map(h => h.parsed.size).filter(Boolean))].sort().join(', ');
          rows.push({ type: 'BASE_NO_SIZE', shopifyProduct: p.title, shopifyVariant: v.title,
            shopifySku: sku, gs1Desc: baseHits[0].desc, gs1Ean: '',
            similarity: 'base 100%', reason: `Base matches but size "${skuParsed.size}" not in GS1. GS1 has: ${availSizes}` });
        }
        continue;
      }

      // 3. Fuzzy match — but ONLY consider GS1 entries with the SAME style name (or very close)
      //    This prevents MARA matching ABINAYA etc.
      let candidates = [];

      // 3a. Find GS1 bases that share the same style
      const sameStyleBases = gs1ByStyle.get(skuStyleNorm);
      if (sameStyleBases) {
        // Exact style match — search within those bases
        for (const gBase of sameStyleBases) {
          const d = levenshtein(skuBaseNorm, gBase);
          const sim = 1 - d / Math.max(skuBaseNorm.length, gBase.length);
          if (sim >= 0.5) {
            candidates.push({ baseKey: gBase, dist: d, sim, styleMatch: 'exact' });
          }
        }
      }

      // 3b. Also try fuzzy style match (for typos like ARBROSE→AMBROSE)
      if (candidates.length === 0) {
        for (const [gStyle, gBases] of gs1ByStyle) {
          if (Math.abs(gStyle.length - skuStyleNorm.length) > 3) continue;
          const styleDist = levenshtein(skuStyleNorm, gStyle);
          const styleSim = 1 - styleDist / Math.max(skuStyleNorm.length, gStyle.length);
          if (styleSim >= 0.7 && styleDist <= 3) {
            // Close style — check bases
            for (const gBase of gBases) {
              const d = levenshtein(skuBaseNorm, gBase);
              const sim = 1 - d / Math.max(skuBaseNorm.length, gBase.length);
              if (sim >= 0.5) {
                candidates.push({ baseKey: gBase, dist: d, sim, styleMatch: `fuzzy (${gStyle})` });
              }
            }
          }
        }
      }

      if (candidates.length > 0) {
        // Pick best candidate
        candidates.sort((a, b) => a.dist - b.dist);
        const best = candidates[0];
        const bestHits = gs1ByBase.get(best.baseKey);

        // Try to find size match
        const sizeMatch = bestHits.find(h => h.parsed.size === skuParsed.size);

        // Check if style name actually matches (first word)
        const gs1Style = norm(bestHits[0].parsed.style);
        const styleOk = gs1Style === skuStyleNorm || levenshtein(gs1Style, skuStyleNorm) <= 3;

        if (!styleOk) {
          // Style name is different — NOT a match (e.g. MARA vs ABINAYA)
          rows.push({ type: 'NO_MATCH_WRONG_STYLE', shopifyProduct: p.title, shopifyVariant: v.title,
            shopifySku: sku, gs1Desc: bestHits[0].desc, gs1Ean: '',
            similarity: (best.sim * 100).toFixed(1) + '%',
            reason: `Style mismatch: Shopify "${skuParsed.style}" vs GS1 "${bestHits[0].parsed.style}" - different product` });
          continue;
        }

        if (sizeMatch) {
          const uniqueEans = [...new Set(bestHits.filter(h => h.parsed.size === skuParsed.size).map(h => h.ean))];
          rows.push({ type: 'FUZZY_WITH_SIZE', shopifyProduct: p.title, shopifyVariant: v.title,
            shopifySku: sku, gs1Desc: sizeMatch.desc,
            gs1Ean: uniqueEans.length === 1 ? uniqueEans[0] : uniqueEans.join(' | '),
            similarity: (best.sim * 100).toFixed(1) + '%',
            reason: `Style "${skuParsed.style}" matches, base fuzzy (dist ${best.dist}), size "${skuParsed.size}" found` });
        } else {
          const availSizes = [...new Set(bestHits.map(h => h.parsed.size).filter(Boolean))].sort().join(', ');
          rows.push({ type: 'FUZZY_NO_SIZE', shopifyProduct: p.title, shopifyVariant: v.title,
            shopifySku: sku, gs1Desc: bestHits[0].desc, gs1Ean: '',
            similarity: (best.sim * 100).toFixed(1) + '%',
            reason: `Style matches, base fuzzy (dist ${best.dist}), but size "${skuParsed.size}" not in GS1. Has: ${availSizes}` });
        }
        continue;
      }

      // 4. No match at all
      rows.push({ type: 'NO_MATCH', shopifyProduct: p.title, shopifyVariant: v.title,
        shopifySku: sku, gs1Desc: '', gs1Ean: '',
        similarity: '', reason: 'No matching style found in GS1' });
    }
  }

  // Sort
  const typeOrder = { EXACT: 0, EXACT_AMBIGUOUS: 1, BASE_SIZE_MATCH: 2, BASE_NO_SIZE: 3,
    FUZZY_WITH_SIZE: 4, FUZZY_NO_SIZE: 5, NO_MATCH_WRONG_STYLE: 6, NO_MATCH: 7, NO_SKU: 8 };
  rows.sort((a, b) => {
    const to = (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
    if (to !== 0) return to;
    if (a.similarity && b.similarity) return parseFloat(b.similarity) - parseFloat(a.similarity);
    return 0;
  });

  // Write CSV
  const header = 'match_type,shopify_product_title,shopify_variant,shopify_sku,gs1_description,gs1_ean,similarity,reason';
  const csvRows = rows.map(r =>
    [r.type, r.shopifyProduct, r.shopifyVariant, r.shopifySku, r.gs1Desc, r.gs1Ean, r.similarity, r.reason]
      .map(csvEscape).join(',')
  );

  const outPath = path.resolve(__dirname, '../../Downloads/fuzzy-match-review-v2.csv');
  fs.writeFileSync(outPath, [header, ...csvRows].join('\n'), 'utf8');

  // Summary
  const counts = {};
  for (const r of rows) counts[r.type] = (counts[r.type] || 0) + 1;
  console.log('\nSummary:');
  for (const [type, count] of Object.entries(typeOrder)) {
    if (counts[type]) console.log(`  ${type.padEnd(25)} ${counts[type]}`);
  }
  console.log(`  ${'─'.repeat(35)}`);
  console.log(`  ${'TOTAL'.padEnd(25)} ${rows.length}`);

  const safeToApply = (counts['EXACT'] || 0) + (counts['BASE_SIZE_MATCH'] || 0) + (counts['FUZZY_WITH_SIZE'] || 0);
  console.log(`\n  Potentially safe to apply: ${safeToApply} (EXACT + BASE_SIZE + FUZZY_WITH_SIZE)`);
  console.log(`\n  CSV: ${outPath}`);
})();
