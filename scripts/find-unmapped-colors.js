const c = require('../dist/config').loadConfig();
const m = require('../dist/config').loadMappingConfig();
const S = require('../dist/shopifyClient').ShopifyClient;

(async function() {
  const s = new S(c);
  const p = await s.fetchAllProducts();
  const unmapped = {};
  for (const pr of p) {
    for (const v of pr.variants) {
      for (const o of v.selectedOptions) {
        const isColor = m.optionAliases.color.some(a => a.toLowerCase() === o.name.toLowerCase());
        if (isColor && o.value && !m.colourFacetMappings[o.value]) {
          unmapped[o.value] = (unmapped[o.value] || 0) + 1;
        }
      }
    }
  }
  const sorted = Object.entries(unmapped).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) {
    process.stdout.write(v + ': ' + k + '\n');
  }
})();
