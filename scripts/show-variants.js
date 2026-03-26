const c = require('../dist/config');
const cfg = c.loadConfig();
const S = require('../dist/shopifyClient').ShopifyClient;
(async () => {
  const s = new S(cfg);
  const p = await s.fetchAllProducts();
  let count = 0;
  for (const pr of p) {
    for (const v of pr.variants) {
      if (!v.barcode?.trim() && count < 30) {
        const opts = v.selectedOptions.map(o => o.name + '=' + o.value).join(', ');
        process.stdout.write(pr.title + ' | ' + v.title + ' | SKU=' + (v.sku || 'none') + ' | ' + opts + '\n');
        count++;
      }
    }
  }
})().catch(e => console.error(e.message));
