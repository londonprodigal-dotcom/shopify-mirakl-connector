/**
 * Generate SKUs and prepare EAN assignments for products missing barcodes.
 * Uses Dylan's naming convention: NAME-FABRIC_COLOUR_SIZE
 *
 * READ-ONLY — outputs CSV for review only.
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
    records.push({ ean, desc, status });
  }
  return records;
}

function norm(s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }

async function fetchAllProducts(token) {
  const QUERY = `
    query GetProducts($cursor: String) {
      products(first: 50, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id title
          options { name values }
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
        id: e.node.id,
        title: e.node.title,
        options: e.node.options,
        variants: e.node.variants.edges.map(ve => ({
          id: ve.node.id, sku: ve.node.sku, barcode: ve.node.barcode,
          title: ve.node.title, selectedOptions: ve.node.selectedOptions,
        })),
      });
    }
    cursor = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

// ── SKU Generation Logic ────────────────────────────────────────────────────

// Words to strip from the middle of a product name (not the fabric/story term)
const STRIP_WORDS = new Set([
  'print', 'jacquard', 'barrel', 'neck', 'hem', 'midi', 'mini', 'maxi', 'midaxi',
  'trouser', 'trousers', 'skirt', 'blouse', 'dress', 'shirt', 'top', 'coat', 'jacket',
  'jumpsuit', 'cardigan', 'jumper', 'knitwear', 'knit', 'waistcoat', 'vest',
  'sleeve', 'long', 'short', '3/4', 'tie', 'a-line', 'aline', 'straight', 'wide',
  'leg', 'cut', 'button', 'balloon', 'ballon', 'puff', 'wrap', 'v-neck', 'round',
  'crew', 'collar', 'collared', 'faux', 'fur', 'lined', 'statement', 'evening',
  'crossbody', 'bag', 'beanie', 'hat', 'scarf', 'gloves', 'in', 'the', 'and', 'with',
  'of', 'a', 'an', 'for', '&', 'shimmer', 'sheer', 'relaxed', 'fit', 'fitted',
  'oversized', 'smock', 'smocked', 'tiered', 'pleated', 'belted', 'tab', 'detail',
  'pocket', 'pockets', '2', 'mix', 'linen', 'sustainable', 'organic', 'recycled',
  'shirtdress', 'tea', 'shift', 'cami', 'pinafore', 'dungaree', 'dungarees',
  'cord', 'corduroy', 'denim', 'velvet', 'satin', 'chiffon', 'georgette', 'crepe',
  'jersey', 'cotton', 'wool', 'tweed', 'suede', 'leather', 'feather', 'pom',
]);

// Known fabric/story terms (multi-word)
const FABRIC_PATTERNS = [
  { pattern: /flower\s*press/i, fabric: 'FLOWER-PRESS' },
  { pattern: /cottage\s*check/i, fabric: 'COTTAGE-CHECK' },
  { pattern: /raining\s*rosebuds/i, fabric: 'RAINING-ROSEBUDS' },
  { pattern: /ticking\s*stripe/i, fabric: 'TICKING-STRIPE' },
  { pattern: /diamonds?\s*forever/i, fabric: 'DIAMONDS-FOREVER' },
  { pattern: /carpathian\s*florals?/i, fabric: 'CARPATHIAN-FLORALS' },
  { pattern: /bauhaus\s*abstract/i, fabric: 'BAUHAUS-ABSTRACT' },
  { pattern: /squiggle\s*engineered/i, fabric: 'SQUIGGLE-ENGINEERED' },
  { pattern: /animal\s*teddy/i, fabric: 'ANIMAL-TEDDY' },
  { pattern: /leopard\s*print/i, fabric: 'LEOPARD' },
  { pattern: /floral\s*print/i, fabric: 'FLORAL' },
  { pattern: /stripe[sd]?/i, fabric: 'STRIPE' },
  { pattern: /check[sd]?/i, fabric: 'CHECK' },
  { pattern: /polka\s*dot/i, fabric: 'POLKA-DOT' },
  { pattern: /spot/i, fabric: 'SPOT' },
  { pattern: /herringbone/i, fabric: 'HERRINGBONE' },
  { pattern: /twill/i, fabric: 'TWILL' },
  { pattern: /boucle/i, fabric: 'BOUCLE' },
  { pattern: /brocade/i, fabric: 'BROCADE' },
  { pattern: /broderie/i, fabric: 'BRODERIE' },
  { pattern: /crochet/i, fabric: 'CROCHET' },
  { pattern: /lace/i, fabric: 'LACE' },
  { pattern: /seersucker/i, fabric: 'SEERSUCKER' },
  { pattern: /gingham/i, fabric: 'GINGHAM' },
  { pattern: /paisley/i, fabric: 'PAISLEY' },
  { pattern: /ditsy/i, fabric: 'DITSY' },
  { pattern: /abstract/i, fabric: 'ABSTRACT' },
  { pattern: /geometric/i, fabric: 'GEOMETRIC' },
  { pattern: /textured/i, fabric: 'TEXTURED' },
  { pattern: /embroidered/i, fabric: 'EMBROIDERED' },
  { pattern: /bow/i, fabric: 'BOW' },
  { pattern: /blossom/i, fabric: 'BLOSSOM' },
  { pattern: /daisy/i, fabric: 'DAISY' },
  { pattern: /rose/i, fabric: 'ROSE' },
  { pattern: /flutter/i, fabric: 'FLUTTER' },
  { pattern: /beetlejuice/i, fabric: 'BEETLEJUICE' },
  { pattern: /dazzler/i, fabric: 'DAZZLER' },
  { pattern: /baby\s*cord/i, fabric: 'BABYCORD' },
];

function extractFabric(title) {
  // Remove the first word (style name) and try to find a fabric term
  const words = title.split(/\s+/);
  const rest = words.slice(1).join(' ');

  for (const fp of FABRIC_PATTERNS) {
    if (fp.pattern.test(rest)) {
      return fp.fabric;
    }
  }

  // Fallback: take the significant words between style name and colour/garment type
  const significant = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!w) continue;
    if (STRIP_WORDS.has(w)) continue;
    // Stop at colour-like words or if we've collected enough
    if (significant.length >= 3) break;
    significant.push(w.toUpperCase());
  }

  return significant.length > 0 ? significant.join('-') : null;
}

function extractColour(variant) {
  // Check selectedOptions for colour
  for (const opt of (variant.selectedOptions || [])) {
    const name = opt.name.toLowerCase();
    if (name === 'color' || name === 'colour' || name === 'color/pattern') {
      let col = opt.value.trim().toUpperCase();
      if (/MULTI/i.test(col)) return 'MULTI';
      // Normalise common colours
      col = col.replace(/\s+/g, '-');
      return col;
    }
  }
  return null;
}

function extractSize(variant) {
  for (const opt of (variant.selectedOptions || [])) {
    if (opt.name.toLowerCase() === 'size') {
      const s = opt.value.trim();
      // Pad single digit sizes
      if (/^\d$/.test(s)) return '0' + s;
      if (/^\d{2}$/.test(s)) return s;
      return s.toUpperCase();
    }
  }
  // Fallback: variant title might be the size
  const t = variant.title.trim();
  if (/^\d{1,2}$/.test(t)) return t.length === 1 ? '0' + t : t;
  return t.toUpperCase();
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
  // Load GS1 to find available (unused) EANs
  let allRecords = [];
  for (const f of GS1_FILES) allRecords = allRecords.concat(parseGS1(f));

  // Find EANs that are "Available" and have no description assigned yet
  const usedEans = new Set();
  const gs1ByNorm = new Map();
  for (const r of allRecords) {
    usedEans.add(r.ean);
    const key = norm(r.desc);
    if (!gs1ByNorm.has(key)) gs1ByNorm.set(key, []);
    gs1ByNorm.get(key).push(r);
  }

  console.log(`GS1 records: ${allRecords.length}`);

  // Fetch Shopify
  console.log('Fetching Shopify...');
  const token = await getAccessToken();
  const products = await fetchAllProducts(token);
  console.log(`Products: ${products.length}`);

  // Collect all existing barcodes in Shopify
  const shopifyEans = new Set();
  for (const p of products) {
    for (const v of p.variants) {
      if (v.barcode?.trim()) shopifyEans.add(v.barcode.trim());
    }
  }

  // Products to exclude (don't need EANs)
  const EXCLUDE_PATTERNS = [
    /gift\s*card/i, /gift\s*voucher/i, /e-?gift/i,
    /bundle/i, /set\s+of/i,
    /sample/i, /swatch/i,
    /shipping/i, /delivery/i, /postage/i,
  ];

  function shouldExclude(title) {
    return EXCLUDE_PATTERNS.some(p => p.test(title));
  }

  // Find variants that need SKUs/EANs
  const rows = [];
  let excluded = 0;

  for (const p of products) {
    if (shouldExclude(p.title)) { excluded += p.variants.length; continue; }

    for (const v of p.variants) {
      if (v.barcode?.trim()) continue; // already has barcode

      const currentSku = v.sku?.trim() || '';
      const colour = extractColour(v);
      const size = extractSize(v);
      const fabric = extractFabric(p.title);
      const styleName = p.title.split(/\s+/)[0].toUpperCase();

      // Strip "Louche " prefix if present
      const cleanTitle = p.title.replace(/^Louche\s+/i, '');
      const cleanStyleName = cleanTitle.split(/\s+/)[0].toUpperCase();
      const cleanFabric = extractFabric(cleanTitle);

      const finalStyle = cleanStyleName;
      const finalFabric = cleanFabric || fabric;

      // Build proposed SKU
      let proposedSku = '';
      if (finalFabric && colour) {
        proposedSku = `${finalStyle}-${finalFabric}_${colour}_${size}`;
      } else if (finalFabric) {
        proposedSku = `${finalStyle}-${finalFabric}_${size}`;
      } else if (colour) {
        proposedSku = `${finalStyle}_${colour}_${size}`;
      } else {
        proposedSku = `${finalStyle}_${size}`;
      }

      // Check if proposed SKU already has a GS1 match
      const proposedNorm = norm(proposedSku);
      const gs1Match = gs1ByNorm.get(proposedNorm);
      let gs1Ean = '';
      let gs1Note = '';
      if (gs1Match) {
        const uniqueEans = [...new Set(gs1Match.map(h => h.ean))];
        if (uniqueEans.length === 1) {
          gs1Ean = uniqueEans[0];
          gs1Note = 'Proposed SKU matches existing GS1 entry';
        } else {
          gs1Note = `Proposed SKU matches GS1 but ${uniqueEans.length} EANs: ${uniqueEans.join(', ')}`;
        }
      } else {
        gs1Note = 'New - needs GS1 registration';
      }

      // Determine status
      let status;
      if (currentSku && gs1ByNorm.get(norm(currentSku))?.length > 0) {
        // Current SKU has an exact GS1 match already — was probably ambiguous
        const hits = gs1ByNorm.get(norm(currentSku));
        const eans = [...new Set(hits.map(h => h.ean))];
        status = eans.length === 1 ? 'HAS_SKU_HAS_EAN' : 'HAS_SKU_AMBIGUOUS_EAN';
        gs1Ean = eans.join(' | ');
        gs1Note = eans.length === 1 ? 'Current SKU matches GS1' : `Current SKU matches but ${eans.length} EANs`;
      } else if (currentSku) {
        status = 'HAS_SKU_NO_EAN';
      } else {
        status = 'NEEDS_SKU_AND_EAN';
      }

      rows.push({
        status,
        shopifyProduct: p.title,
        shopifyVariant: v.title,
        currentSku,
        proposedSku,
        colour: colour || '',
        size,
        gs1Ean,
        gs1Note,
        variantGid: v.id,
        productGid: p.id,
      });
    }
  }

  // Sort: NEEDS_SKU first, then HAS_SKU_NO_EAN, then the rest
  const statusOrder = { NEEDS_SKU_AND_EAN: 0, HAS_SKU_NO_EAN: 1, HAS_SKU_AMBIGUOUS_EAN: 2, HAS_SKU_HAS_EAN: 3 };
  rows.sort((a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99));

  // Write CSV
  const header = 'status,shopify_product_title,shopify_variant,current_sku,proposed_sku,colour,size,gs1_ean,note';
  const csvRows = rows.map(r =>
    [r.status, r.shopifyProduct, r.shopifyVariant, r.currentSku, r.proposedSku, r.colour, r.size, r.gs1Ean, r.gs1Note]
      .map(csvEscape).join(',')
  );

  const outPath = path.resolve(__dirname, '../../Downloads/sku-ean-generator.csv');
  fs.writeFileSync(outPath, [header, ...csvRows].join('\n'), 'utf8');

  // Summary
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log('\nSummary:');
  for (const [s, c] of Object.entries(counts)) {
    console.log(`  ${s.padEnd(30)} ${c}`);
  }
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  ${'TOTAL'.padEnd(30)} ${rows.length}`);
  console.log(`  Excluded (gift cards etc):   ${excluded}`);
  console.log(`\nCSV: ${outPath}`);
})();
