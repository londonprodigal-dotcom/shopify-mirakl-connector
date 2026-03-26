/**
 * GS1 EAN → Shopify barcode matching (v3).
 *
 * GS1 naming: NAME-FABRIC_COLOUR_SIZE  (e.g. AUBIN-COTTAGE-CHECK-GRN_8)
 * Shopify:    "Louche Aubin Cottage Check A Line Mini Skirt Green" + Size=8, Colour=Green
 *
 * Strategy: build a composite key from GS1 desc (everything before colour_size)
 * and match against Shopify title keywords + colour + size.
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

// Colour aliases: Shopify colour → possible GS1 colour abbreviations
const COLOUR_ALIASES = {
  'green': ['green', 'grn', 'gre'],
  'blue': ['blue', 'blu'],
  'red': ['red'],
  'black': ['black', 'blk'],
  'white': ['white', 'wht', 'off white', 'off_white', 'offwhite'],
  'navy': ['navy', 'nvy'],
  'pink': ['pink', 'pnk'],
  'yellow': ['yellow', 'yel', 'ylw'],
  'multi': ['multi', 'multicolour', 'multicoloured', 'multi colour'],
  'multicolour': ['multi', 'multicolour', 'multicoloured'],
  'cream': ['cream', 'crm'],
  'orange': ['orange', 'org'],
  'purple': ['purple', 'prp'],
  'brown': ['brown', 'brn'],
  'grey': ['grey', 'gry', 'gray'],
  'mustard': ['mustard', 'mstd'],
  'teal': ['teal'],
  'coral': ['coral'],
  'burgundy': ['burgundy', 'burg'],
  'khaki': ['khaki'],
  'nude': ['nude'],
  'gold': ['gold'],
  'silver': ['silver'],
  'natural': ['natural', 'nat'],
  'stone': ['stone'],
  'camel': ['camel'],
  'ivory': ['ivory'],
  'beige': ['beige'],
  'olive': ['olive'],
  'charcoal': ['charcoal'],
  'lilac': ['lilac'],
  'mint': ['mint'],
  'plum': ['plum'],
  'rust': ['rust'],
  'sage': ['sage'],
  'rose': ['rose'],
  'copper': ['copper'],
  'wine': ['wine'],
  'oatmeal': ['oatmeal'],
  'fern': ['fern'],
  'apricot': ['apricot'],
  'ginger': ['ginger'],
  'mole': ['mole'],
  'tortoiseshell': ['tortoiseshell', 'tort'],
  'pearl': ['pearl'],
  'hot pink': ['hot_pink', 'hot-pink', 'hotpink'],
};

// Filler words to strip from Shopify titles when building match keys
const FILLER = new Set([
  'louche', 'in', 'a', 'the', 'with', 'and', '&', 'line', 'of', 'for',
  'print', 'printed', 'midi', 'mini', 'maxi', 'dress', 'skirt', 'trouser',
  'trousers', 'blouse', 'top', 'shirt', 'coat', 'jacket', 'jumper', 'cardigan',
  'playsuit', 'jumpsuit', 'shorts', 'scarf', 'hat', 'bag', 'belt', 'earring',
  'earrings', 'necklace', 'bracelet', 'ring', 'clip', 'clips', 'beanie',
  'sunglasses', 'umbrella', 'purse', 'gloves', 'headband',
  'sleeve', 'long', 'short', 'neck', 'hem', 'front', 'back', 'tie', 'cut',
  'straight', 'wide', 'leg', 'flared', 'wrap', 'button', 'zip', 'v',
  'puff', 'barrel', 'ruffle', 'ruffled', 'frill', 'collar', 'detail',
  'panel', 'patch', 'pocket', 'pockets', 'lace', 'trim', 'trimmed',
  'fitted', 'relaxed', 'oversized', 'cropped', 'high', 'low', 'waist',
  'length', 'full', 'half', 'quarter', 'three',
  'strappy', 'strapless', 'halter', 'cami', 'boxy',
  'pinstripe', 'stripe', 'striped', 'check', 'checked', 'plaid',
  'floral', 'spot', 'spotted', 'dot', 'polka',
  'velvet', 'satin', 'silk', 'linen', 'cotton', 'mix', 'knit', 'knitted',
  'jersey', 'crepe', 'chiffon', 'denim', 'cord', 'corduroy', 'faux', 'fur',
  'leather', 'suede', 'wool', 'tweed', 'herringbone', 'jacquard', 'brocade',
  'extended', 'shoulder', 'waistcoat', 'ballon', 'balloon',
]);

function norm(s) {
  return s.toLowerCase().replace(/[''`]/g, '').replace(/[^a-z0-9/]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

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
    records.push({ ean, status, desc });
  }
  return records;
}

// Parse GS1 description into a lookup key
// Format: NAME-FABRIC_COLOUR_SIZE → normalised "name_fabric" as key, colour and size separate
function parseGS1Key(desc) {
  const n = norm(desc).replace(/^louche_/, '');

  // Extract size from end: _8, _08, _10, _one_size, etc.
  const sizeMatch = n.match(/_(\d{1,2}|one_size|os)$/);
  const size = sizeMatch ? sizeMatch[1].replace(/^0(\d)$/, '$1') : null;
  const noSize = sizeMatch ? n.slice(0, -sizeMatch[0].length) : n;

  // Everything is the "full key" including colour
  // We'll index by full key + size for exact matching
  return { fullKey: noSize, size, raw: desc };
}

// Build Shopify → GS1 search keys from product title + variant options
function buildShopifyKeys(title, colour, size) {
  const clean = title.replace(/^Louche\s+/i, '').trim();
  // Normalise size: "8" → "8" (no zero-pad for matching)
  const normSize = size.replace(/^0+(\d)/, '$1').toLowerCase().trim();

  // Extract all meaningful words from Shopify title
  const words = clean.split(/[\s\-–]+/).map(w => w.toLowerCase());

  // Get the style name (first word)
  const style = words[0];

  // Get "fabric/story" words = everything between style and colour/filler
  // Remove filler words and the colour from the title
  const normColour = norm(colour);
  const storyWords = words.slice(1).filter(w => {
    const nw = w.toLowerCase();
    if (FILLER.has(nw)) return false;
    if (nw === normColour) return false;
    // Remove colour words that appear at end of title
    for (const [, aliases] of Object.entries(COLOUR_ALIASES)) {
      if (aliases.includes(nw)) return false;
    }
    return true;
  });

  // Build GS1-style key: STYLE-STORY words joined with underscores
  const storyPart = storyWords.length > 0 ? '_' + storyWords.join('_') : '';
  const baseKey = norm(style + storyPart);

  // Get all possible GS1 colour values
  const colourVariants = getColourVariants(colour);

  const keys = [];
  for (const cv of colourVariants) {
    keys.push(`${baseKey}_${cv}`);  // style_fabric_colour
  }
  // Also try without colour (for products where colour is embedded in fabric name)
  keys.push(baseKey);
  // Try full normalised title without filler
  const fullKey = norm(words.filter(w => !FILLER.has(w.toLowerCase())).join('_'));
  for (const cv of colourVariants) {
    keys.push(`${fullKey}_${cv}`);
  }
  keys.push(fullKey);

  return { keys, normSize, style };
}

function getColourVariants(colour) {
  if (!colour) return [''];
  const nc = colour.toLowerCase().trim();
  const variants = new Set([norm(nc)]);

  // Check aliases
  for (const [shopifyCol, gs1Cols] of Object.entries(COLOUR_ALIASES)) {
    if (nc === shopifyCol || nc.includes(shopifyCol)) {
      gs1Cols.forEach(a => variants.add(norm(a)));
    }
  }

  // Handle compound colours: "Red/White" → "red/white", "red", "red_white"
  if (nc.includes('/')) {
    const parts = nc.split('/');
    variants.add(norm(parts.join('_')));
    variants.add(norm(parts[0])); // just first colour
    // Also add abbreviations of each part
    for (const p of parts) {
      const pn = p.trim().toLowerCase();
      if (COLOUR_ALIASES[pn]) {
        COLOUR_ALIASES[pn].forEach(a => variants.add(norm(a)));
      }
    }
  }

  return [...variants];
}

(async function () {
  console.log('Loading GS1 exports...');
  let allRecords = [];
  for (const f of GS1_FILES) {
    const recs = parseGS1(f);
    console.log(`  ${path.basename(f)}: ${recs.length} records`);
    allRecords = allRecords.concat(recs);
  }
  console.log(`Total: ${allRecords.length}`);

  const eanMap = new Map();
  for (const r of allRecords) {
    if (!eanMap.has(r.ean)) eanMap.set(r.ean, r);
  }
  console.log(`Unique EANs: ${eanMap.size}`);

  // Build GS1 index: fullKey → [{ean, size, raw}]
  const gs1Index = new Map();
  for (const [ean, rec] of eanMap) {
    const parsed = parseGS1Key(rec.desc);
    const key = parsed.fullKey;
    if (!gs1Index.has(key)) gs1Index.set(key, []);
    gs1Index.get(key).push({ ean, size: parsed.size, raw: parsed.raw });
  }

  // Fetch Shopify
  console.log('\nFetching Shopify products...');
  const cfg = c.loadConfig();
  const shop = new S(cfg);
  const products = await shop.fetchAllProducts();

  let totalVariants = 0, withBarcode = 0, withoutBarcode = 0;
  const needBarcode = [];
  const haveBarcode = [];

  for (const p of products) {
    for (const v of p.variants) {
      totalVariants++;
      let bc = v.barcode?.trim() || '';
      if (bc && bc.includes('E+')) bc = BigInt(Math.round(Number(bc))).toString();
      if (bc) {
        withBarcode++;
        haveBarcode.push({ product: p, variant: v, barcode: bc });
      } else {
        withoutBarcode++;
        needBarcode.push({ product: p, variant: v });
      }
    }
  }

  console.log(`Variants: ${totalVariants} (${withBarcode} have barcode, ${withoutBarcode} need)`);

  // Existing barcodes vs GS1
  let inGS1 = 0;
  for (const { barcode } of haveBarcode) { if (eanMap.has(barcode)) inGS1++; }
  console.log(`Existing barcodes in GS1: ${inGS1}/${withBarcode}`);

  // Match
  console.log('\n=== Matching ===');
  let matched = 0, ambiguous = 0, unmatched = 0;
  const results = [];
  const ambiguousList = [];
  const unmatchedList = [];

  for (const { product, variant } of needBarcode) {
    const colour = variant.selectedOptions.find(o =>
      ['Colour', 'Color', 'colour', 'color'].includes(o.name)
    )?.value || '';
    const sizeOpt = variant.selectedOptions.find(o =>
      ['Size', 'UK Size', 'UK size', 'size'].includes(o.name)
    )?.value || variant.title;

    const { keys, normSize } = buildShopifyKeys(product.title, colour, sizeOpt);

    let found = null;
    let matchKey = null;
    for (const key of keys) {
      const hits = gs1Index.get(key);
      if (!hits) continue;

      // Filter by size
      const sizeHits = hits.filter(h => h.size === normSize || h.size === (normSize.length === 1 ? '0' + normSize : normSize));

      if (sizeHits.length === 1) {
        found = sizeHits[0];
        matchKey = key + '_' + normSize;
        break;
      } else if (sizeHits.length > 1) {
        // Multiple EANs for same key+size → ambiguous
        const uniqueEans = new Set(sizeHits.map(h => h.ean));
        if (uniqueEans.size === 1) {
          found = sizeHits[0];
          matchKey = key + '_' + normSize;
          break;
        }
        if (ambiguousList.length < 15) {
          ambiguousList.push({
            shopify: `${product.title} / ${variant.title}`,
            key: key + '_' + normSize,
            options: sizeHits.slice(0, 5).map(h => `${h.ean} (${h.raw})`),
          });
        }
        ambiguous++;
        found = 'AMB';
        break;
      }
    }

    if (found && found !== 'AMB') {
      matched++;
      results.push({
        shopifyProduct: product.title,
        shopifyVariant: variant.title,
        variantId: variant.numericId,
        ean: found.ean,
        gs1Desc: found.raw,
        matchKey,
      });
    } else if (found !== 'AMB') {
      unmatched++;
      if (unmatchedList.length < 20) {
        // Find what GS1 records exist for this style
        const style = product.title.replace(/^Louche\s+/i, '').split(/[\s\-]/)[0].toLowerCase();
        const gs1ForStyle = [];
        for (const [key, hits] of gs1Index) {
          if (key.startsWith(style + '_') || key === style) {
            gs1ForStyle.push(key + ' → ' + hits[0].raw);
            if (gs1ForStyle.length >= 3) break;
          }
        }
        unmatchedList.push({
          shopify: `${product.title} / ${variant.title} (${colour || 'no colour'})`,
          triedKeys: keys.slice(0, 3),
          gs1Samples: gs1ForStyle,
        });
      }
    }
  }

  console.log(`Matched: ${matched}`);
  console.log(`Ambiguous: ${ambiguous}`);
  console.log(`Unmatched: ${unmatched}`);

  if (ambiguousList.length > 0) {
    console.log('\nAMBIGUOUS (first 15):');
    for (const a of ambiguousList) {
      console.log(`  ${a.shopify} → key "${a.key}"`);
      a.options.forEach(o => console.log(`    ${o}`));
    }
  }

  if (unmatchedList.length > 0) {
    console.log('\nUNMATCHED (first 20):');
    for (const u of unmatchedList) {
      console.log(`  ${u.shopify}`);
      console.log(`    tried: ${u.triedKeys.join(', ')}`);
      if (u.gs1Samples.length > 0) {
        console.log(`    GS1 for this style: ${u.gs1Samples.join(' | ')}`);
      } else {
        console.log(`    No GS1 records for this style`);
      }
    }
  }

  // Conflict check
  const eanAssign = new Map();
  for (const m of results) {
    if (!eanAssign.has(m.ean)) eanAssign.set(m.ean, []);
    eanAssign.get(m.ean).push(m);
  }
  for (const { barcode, product, variant } of haveBarcode) {
    if (!eanAssign.has(barcode)) eanAssign.set(barcode, []);
    eanAssign.get(barcode).push({
      shopifyProduct: product.title, shopifyVariant: variant.title,
      variantId: variant.numericId, ean: barcode, existing: true
    });
  }
  const conflicts = [...eanAssign.entries()].filter(([, v]) =>
    v.length > 1 && v.some(r => !r.existing)
  );
  console.log(`\nConflicts: ${conflicts.length}`);
  for (const [ean, recs] of conflicts.slice(0, 10)) {
    console.log(`  EAN ${ean}:`);
    recs.forEach(r => console.log(`    ${r.existing ? '[EXISTS]' : '[NEW]  '} ${r.shopifyProduct} / ${r.shopifyVariant}`));
  }

  // Summary
  console.log('\n════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('════════════════════════════════════════════');
  console.log(`  GS1 unique EANs:           ${eanMap.size}`);
  console.log(`  Shopify variants:           ${totalVariants}`);
  console.log(`  Already have barcode:       ${withBarcode}`);
  console.log(`  Need barcode:               ${withoutBarcode}`);
  console.log(`  Auto-matched from GS1:      ${matched}`);
  console.log(`  Ambiguous (need review):    ${ambiguous}`);
  console.log(`  Could not match:            ${unmatched}`);
  console.log(`  Safe to apply:              ${matched - conflicts.length}`);
  console.log(`  New coverage:               ${withBarcode + matched} / ${totalVariants} (${Math.round((withBarcode + matched) / totalVariants * 100)}%)`);
  console.log('════════════════════════════════════════════');

  // Write match results
  if (results.length > 0) {
    const outPath = path.resolve(__dirname, '..', 'output', 'gs1-match-results.csv');
    const lines = ['shopify_product;shopify_variant;variant_id;ean;gs1_description;match_key'];
    for (const m of results) {
      lines.push(`"${m.shopifyProduct}";"${m.shopifyVariant}";"${m.variantId}";"${m.ean}";"${m.gs1Desc}";"${m.matchKey}"`);
    }
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log(`\nResults: ${outPath}`);
  }
})();
