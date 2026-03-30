/**
 * Apply GS1 EAN matches to Shopify variant barcodes using REST API.
 * Uses Shopify Partner App client credentials (same as MCP) for write_products access.
 *
 * Usage: node scripts/apply-gs1-eans-rest.js
 *        node scripts/apply-gs1-eans-rest.js --dry-run
 */
const fs = require('fs');
const path = require('path');
const { CLIENT_ID, CLIENT_SECRET, SHOP, getAccessToken } = require('./shopify-auth');

const DRY_RUN = process.argv.includes('--dry-run');

const API_VERSION = '2024-01';

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

async function gql(token, query, variables = {}) {
  const resp = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GraphQL HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  const json = await resp.json();
  if (json.errors?.length > 0) {
    throw new Error(`GraphQL: ${json.errors.map(e => e.message).join('; ')}`);
  }
  return json;
}

async function fetchAllProducts(token) {
  const QUERY = `
    query GetProducts($cursor: String) {
      products(first: 50, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id title
          variants(first: 100) { edges { node {
            id sku barcode
          } } }
        } }
      }
    }
  `;
  const products = [];
  let cursor = null;
  let page = 0;
  do {
    page++;
    const result = await gql(token, QUERY, { cursor });
    const data = result.data.products;
    for (const e of data.edges) {
      const p = e.node;
      products.push({
        id: p.id,
        title: p.title,
        variants: p.variants.edges.map(ve => ({
          id: ve.node.id,
          sku: ve.node.sku,
          barcode: ve.node.barcode,
          numericId: ve.node.id.split('/').pop(),
        })),
      });
    }
    console.log(`  Page ${page}: ${products.length} products`);
    cursor = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

(async function () {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== APPLYING BARCODES ===');

  // Load GS1
  let allRecords = [];
  for (const f of GS1_FILES) allRecords = allRecords.concat(parseGS1(f));
  const gs1ByDesc = new Map();
  for (const r of allRecords) {
    const key = norm(r.desc);
    if (!gs1ByDesc.has(key)) gs1ByDesc.set(key, []);
    gs1ByDesc.get(key).push(r);
  }
  console.log(`GS1 records: ${allRecords.length}`);

  // Get OAuth token with write_products scope
  console.log('Authenticating with Shopify Partner App...');
  const token = await getAccessToken();
  console.log('Token obtained.');

  // Fetch products
  console.log('Fetching Shopify products...');
  const products = await fetchAllProducts(token);
  console.log(`Fetched ${products.length} products.`);

  // Build updates
  const updates = [];
  const existingEans = new Set();

  for (const p of products) {
    for (const v of p.variants) {
      let bc = v.barcode?.trim() || '';
      if (bc && bc.includes('E+')) bc = BigInt(Math.round(Number(bc))).toString();
      if (bc) existingEans.add(bc);
    }
  }

  let skipped = 0, conflicts = 0, ambiguous = 0, noSku = 0;
  for (const p of products) {
    for (const v of p.variants) {
      let bc = v.barcode?.trim() || '';
      if (bc && bc.includes('E+')) bc = BigInt(Math.round(Number(bc))).toString();
      if (bc) continue;

      const sku = v.sku?.trim();
      if (!sku) { noSku++; continue; }

      const key = norm(sku);
      const hits = gs1ByDesc.get(key);
      if (!hits) { skipped++; continue; }

      const uniqueEans = new Set(hits.map(h => h.ean));
      if (uniqueEans.size > 1) { ambiguous++; continue; }

      const ean = hits[0].ean;
      if (existingEans.has(ean)) { conflicts++; continue; }

      const existingUpdate = updates.find(u => u.ean === ean);
      if (existingUpdate) { conflicts++; continue; }

      updates.push({
        productTitle: p.title,
        productGid: p.id,
        variantGid: v.id,
        sku,
        ean,
      });
    }
  }

  console.log(`\nUpdates to apply: ${updates.length}`);
  console.log(`Skipped (no GS1 match): ${skipped}`);
  console.log(`Ambiguous: ${ambiguous}`);
  console.log(`Conflicts: ${conflicts}`);
  console.log(`No SKU: ${noSku}`);

  if (DRY_RUN) {
    console.log('\nDRY RUN - no changes made.');
    for (const u of updates.slice(0, 10)) {
      console.log(`  ${u.productTitle} -> EAN ${u.ean} (SKU: ${u.sku})`);
    }
    return;
  }

  // Group by product
  const byProduct = new Map();
  for (const u of updates) {
    if (!byProduct.has(u.productGid)) byProduct.set(u.productGid, []);
    byProduct.get(u.productGid).push(u);
  }

  const MUTATION = `
    mutation UpdateBarcodes($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id barcode }
        userErrors { field message }
      }
    }
  `;

  console.log(`\nApplying ${updates.length} barcode updates across ${byProduct.size} products...`);

  let applied = 0, errors = 0;
  const entries = [...byProduct.entries()];
  const BATCH = 5;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);

    const results = await Promise.all(batch.map(async ([productGid, variants]) => {
      try {
        const result = await gql(token, MUTATION, {
          productId: productGid,
          variants: variants.map(v => ({ id: v.variantGid, barcode: v.ean })),
        });
        const ue = result.data?.productVariantsBulkUpdate?.userErrors;
        if (ue?.length > 0) throw new Error(ue.map(e => e.message).join('; '));
        return { success: true, count: variants.length };
      } catch (err) {
        return { success: false, error: err.message, variants };
      }
    }));

    for (const r of results) {
      if (r.success) {
        applied += r.count;
      } else {
        errors += r.variants.length;
        console.error(`  ERROR (${r.variants[0].productTitle}): ${r.error}`);
      }
    }

    const done = Math.min(i + BATCH, entries.length);
    if (done % 50 === 0 || done >= entries.length) {
      console.log(`  Progress: ${done}/${entries.length} products (${applied} applied, ${errors} errors)`);
    }

    if (i + BATCH < entries.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n════════════════════════════════════════════`);
  console.log(`  COMPLETE`);
  console.log(`════════════════════════════════════════════`);
  console.log(`  Applied: ${applied}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Previous barcodes: ~1257`);
  console.log(`  New total: ~${1257 + applied}`);
  console.log(`════════════════════════════════════════════`);
})();
