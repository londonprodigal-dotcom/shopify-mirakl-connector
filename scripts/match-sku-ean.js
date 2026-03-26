/**
 * Match GS1 EANs to Shopify variants by SKU = GS1 Description.
 */
const fs = require('fs');
const path = require('path');
const c = require('../dist/config');
const S = require('../dist/shopifyClient').ShopifyClient;

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
  // Load GS1
  let allRecords = [];
  for (const f of GS1_FILES) {
    const recs = parseGS1(f);
    console.log(`${path.basename(f)}: ${recs.length}`);
    allRecords = allRecords.concat(recs);
  }

  // Build GS1 lookup by normalised description
  const gs1ByDesc = new Map(); // norm(desc) → [{ean, desc}]
  const gs1ByEan = new Map();
  for (const r of allRecords) {
    if (!gs1ByEan.has(r.ean)) gs1ByEan.set(r.ean, r);
    const key = norm(r.desc);
    if (!gs1ByDesc.has(key)) gs1ByDesc.set(key, []);
    gs1ByDesc.get(key).push(r);
  }
  console.log(`GS1 records: ${allRecords.length}, unique EANs: ${gs1ByEan.size}, unique descs: ${gs1ByDesc.size}`);

  // Fetch Shopify
  console.log('\nFetching Shopify...');
  const cfg = c.loadConfig();
  const shop = new S(cfg);
  const products = await shop.fetchAllProducts();

  // First, show some SKU samples to confirm format
  console.log('\nSample SKUs (first 20 without barcodes):');
  let sampleCount = 0;
  for (const p of products) {
    for (const v of p.variants) {
      if (!v.barcode?.trim() && v.sku && sampleCount < 20) {
        console.log(`  SKU: "${v.sku}" | ${p.title} / ${v.title}`);
        sampleCount++;
      }
    }
  }

  // Match by SKU
  console.log('\n=== Matching by SKU ===');
  let total = 0, withBarcode = 0, needBarcode = 0;
  let matched = 0, ambiguous = 0, noSku = 0, unmatched = 0;
  const results = [];
  const ambiguousList = [];
  const unmatchedSamples = [];

  for (const p of products) {
    for (const v of p.variants) {
      total++;
      let bc = v.barcode?.trim() || '';
      if (bc && bc.includes('E+')) bc = BigInt(Math.round(Number(bc))).toString();
      if (bc) { withBarcode++; continue; }
      needBarcode++;

      const sku = v.sku?.trim();
      if (!sku) { noSku++; continue; }

      const key = norm(sku);
      const hits = gs1ByDesc.get(key);

      if (hits && hits.length === 1) {
        matched++;
        results.push({
          product: p.title, variant: v.title, variantId: v.numericId,
          sku, ean: hits[0].ean, gs1Desc: hits[0].desc
        });
      } else if (hits && hits.length > 1) {
        const uniqueEans = new Set(hits.map(h => h.ean));
        if (uniqueEans.size === 1) {
          matched++;
          results.push({
            product: p.title, variant: v.title, variantId: v.numericId,
            sku, ean: hits[0].ean, gs1Desc: hits[0].desc
          });
        } else {
          ambiguous++;
          if (ambiguousList.length < 10) {
            ambiguousList.push({ sku, product: p.title, variant: v.title,
              eans: hits.map(h => `${h.ean} (${h.desc})`) });
          }
        }
      } else {
        unmatched++;
        if (unmatchedSamples.length < 20) {
          // Try to find close matches
          const close = [];
          for (const [k, recs] of gs1ByDesc) {
            if (k.startsWith(key.substring(0, Math.min(15, key.length)))) {
              close.push(recs[0].desc);
              if (close.length >= 3) break;
            }
          }
          unmatchedSamples.push({ sku, product: p.title, variant: v.title, close });
        }
      }
    }
  }

  console.log(`Matched: ${matched}`);
  console.log(`Ambiguous: ${ambiguous}`);
  console.log(`No SKU: ${noSku}`);
  console.log(`Unmatched: ${unmatched}`);

  if (ambiguousList.length > 0) {
    console.log('\nAMBIGUOUS:');
    for (const a of ambiguousList) {
      console.log(`  SKU "${a.sku}" (${a.product} / ${a.variant}):`);
      a.eans.forEach(e => console.log(`    ${e}`));
    }
  }

  if (unmatchedSamples.length > 0) {
    console.log('\nUNMATCHED SKUs (first 20):');
    for (const u of unmatchedSamples) {
      console.log(`  SKU "${u.sku}" (${u.product} / ${u.variant})`);
      if (u.close.length > 0) console.log(`    Close GS1: ${u.close.join(' | ')}`);
    }
  }

  // Conflict check
  const eanAssign = new Map();
  for (const m of results) {
    if (!eanAssign.has(m.ean)) eanAssign.set(m.ean, []);
    eanAssign.get(m.ean).push(m);
  }
  // Check against existing barcodes too
  for (const p of products) {
    for (const v of p.variants) {
      let bc = v.barcode?.trim() || '';
      if (bc && bc.includes('E+')) bc = BigInt(Math.round(Number(bc))).toString();
      if (!bc) continue;
      if (!eanAssign.has(bc)) eanAssign.set(bc, []);
      eanAssign.get(bc).push({ product: p.title, variant: v.title, variantId: v.numericId, ean: bc, existing: true });
    }
  }
  const conflicts = [...eanAssign.entries()].filter(([, v]) =>
    v.length > 1 && v.some(r => !r.existing)
  );
  console.log(`\nConflicts: ${conflicts.length}`);
  for (const [ean, recs] of conflicts.slice(0, 10)) {
    console.log(`  EAN ${ean}:`);
    recs.forEach(r => console.log(`    ${r.existing ? '[EXISTS]' : '[NEW]  '} ${r.product} / ${r.variant} (SKU: ${r.sku || 'n/a'})`));
  }

  // Summary
  console.log('\n════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('════════════════════════════════════════════');
  console.log(`  Shopify variants:           ${total}`);
  console.log(`  Already have barcode:       ${withBarcode}`);
  console.log(`  Need barcode:               ${needBarcode}`);
  console.log(`    Matched by SKU:           ${matched}`);
  console.log(`    Ambiguous:                ${ambiguous}`);
  console.log(`    No SKU on variant:        ${noSku}`);
  console.log(`    SKU not in GS1:           ${unmatched}`);
  console.log(`  Conflicts:                  ${conflicts.length}`);
  console.log(`  Safe to apply:              ${matched - conflicts.length}`);
  console.log(`  New coverage:               ${withBarcode + matched} / ${total} (${Math.round((withBarcode + matched) / total * 100)}%)`);
  console.log('════════════════════════════════════════════');

  // Write results
  if (results.length > 0) {
    const outPath = path.resolve(__dirname, '..', 'output', 'gs1-sku-match-results.csv');
    const lines = ['shopify_product;shopify_variant;variant_id;sku;ean;gs1_description'];
    for (const m of results) {
      lines.push(`"${m.product}";"${m.variant}";"${m.variantId}";"${m.sku}";"${m.ean}";"${m.gs1Desc}"`);
    }
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log(`\nResults: ${outPath}`);
  }
})();
