const { CLIENT_ID, CLIENT_SECRET, SHOP, getAccessToken } = require('./shopify-auth');

(async () => {
  const tok = { access_token: await getAccessToken() };

  const query = `{
    product(id: "gid://shopify/Product/7966020174045") {
      title
      variants(first: 10) { edges { node { sku barcode title } } }
    }
  }`;

  const res = await fetch(`https://${SHOP}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tok.access_token },
    body: JSON.stringify({ query })
  }).then(r => r.json());

  const p = res.data.product;
  console.log(p.title);
  console.log('---');
  for (const e of p.variants.edges) {
    const v = e.node;
    console.log(`  Size ${v.title} | SKU: ${v.sku} | Barcode: ${v.barcode || '(none)'}`);
  }
})();
