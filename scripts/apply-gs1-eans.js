/**
 * Apply GS1 EAN matches to Shopify variant barcodes.
 * Reads the match results, skips conflicts, updates barcodes via GraphQL.
 * Groups updates by product and uses productVariantsBulkUpdate.
 *
 * Usage: railway run node scripts/apply-gs1-eans.js
 *        railway run node scripts/apply-gs1-eans.js --dry-run
 */
const fs = require('fs');
const path = require('path');
const c = require('../dist/config');
const S = require('../dist/shopifyClient').ShopifyClient;

const DRY_RUN = process.argv.includes('--dry-run');

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

  // Fetch Shopify
  console.log('Fetching Shopify products...');
  const cfg = c.loadConfig();
  const shop = new S(cfg);
  const products = await shop.fetchAllProducts();

  // Build updates list — same logic as match script
  const updates = [];
  const existingEans = new Set();

  // First pass: collect existing barcodes
  for (const p of products) {
    for (const v of p.variants) {
      let bc = v.barcode?.trim() || '';
      if (bc && bc.includes('E+')) bc = BigInt(Math.round(Number(bc))).toString();
      if (bc) existingEans.add(bc);
    }
  }

  // Second pass: find matches
  let skipped = 0, conflicts = 0, ambiguous = 0, noSku = 0;
  for (const p of products) {
    for (const v of p.variants) {
      let bc = v.barcode?.trim() || '';
      if (bc && bc.includes('E+')) bc = BigInt(Math.round(Number(bc))).toString();
      if (bc) continue; // already has barcode

      const sku = v.sku?.trim();
      if (!sku) { noSku++; continue; }

      const key = norm(sku);
      const hits = gs1ByDesc.get(key);
      if (!hits) { skipped++; continue; }

      // Check for unique EAN
      const uniqueEans = new Set(hits.map(h => h.ean));
      if (uniqueEans.size > 1) { ambiguous++; continue; }

      const ean = hits[0].ean;

      // Check for conflicts with existing barcodes
      if (existingEans.has(ean)) { conflicts++; continue; }

      // Check for conflicts within our own updates
      const existingUpdate = updates.find(u => u.ean === ean);
      if (existingUpdate) { conflicts++; continue; }

      updates.push({
        productTitle: p.title,
        productGid: p.id, // gid://shopify/Product/...
        variantTitle: v.title,
        variantGid: v.id, // gid://shopify/ProductVariant/...
        variantNumericId: v.numericId,
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
    console.log('\nDRY RUN — no changes made. First 10 updates:');
    for (const u of updates.slice(0, 10)) {
      console.log(`  ${u.productTitle} / ${u.variantTitle} -> EAN ${u.ean} (SKU: ${u.sku})`);
    }
    return;
  }

  // Group updates by product (productVariantsBulkUpdate works per-product)
  const byProduct = new Map();
  for (const u of updates) {
    if (!byProduct.has(u.productGid)) byProduct.set(u.productGid, []);
    byProduct.get(u.productGid).push(u);
  }
  console.log(`\nApplying ${updates.length} barcode updates across ${byProduct.size} products...`);

  let applied = 0, errors = 0;
  const productEntries = [...byProduct.entries()];

  // Process products in batches of 5 to avoid rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < productEntries.length; i += BATCH_SIZE) {
    const batch = productEntries.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(batch.map(async ([productGid, variants]) => {
      try {
        await shop.updateVariantBarcodes(
          productGid,
          variants.map(v => ({ variantGid: v.variantGid, barcode: v.ean }))
        );
        return { success: true, count: variants.length, productGid };
      } catch (err) {
        return { success: false, error: err.message, variants, productGid };
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

    const processed = Math.min(i + BATCH_SIZE, productEntries.length);
    if (processed % 50 === 0 || processed >= productEntries.length) {
      console.log(`  Progress: ${processed} / ${productEntries.length} products (${applied} variants applied, ${errors} errors)`);
    }

    // Rate limit pause between batches
    if (i + BATCH_SIZE < productEntries.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n════════════════════════════════════════════`);
  console.log(`  COMPLETE`);
  console.log(`════════════════════════════════════════════`);
  console.log(`  Applied: ${applied}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Previous barcodes: 1257`);
  console.log(`  New total: ~${1257 + applied}`);
  console.log(`════════════════════════════════════════════`);
})();
