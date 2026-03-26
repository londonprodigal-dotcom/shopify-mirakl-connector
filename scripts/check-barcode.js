const CLIENT_ID = '518104b0e8cc61381f290cc656b77859';
const CLIENT_SECRET = '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';
const SHOP = 'louchelondon.myshopify.com';

(async () => {
  const tok = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' })
  }).then(r => r.json());

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
