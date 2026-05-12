// One-off: register INVENTORY_LEVELS_UPDATE webhook via the OAuth app.
// HMAC will be signed with SHOPIFY_CLIENT_SECRET, which the verifier already
// accepts (verifyHmac.ts iterates config.shopify.webhookSecrets).

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const CALLBACK = 'https://webhook-server-production-aeb5.up.railway.app/webhooks/shopify/inventory';
const TOPIC = 'INVENTORY_LEVELS_UPDATE';

async function refreshOAuth() {
  const r = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!r.ok) throw new Error(`OAuth ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

async function gql(token, query, variables) {
  const r = await fetch(`https://${STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`Non-JSON response (HTTP ${r.status}): ${text.slice(0, 400)}`); }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 400)}`);
  return parsed;
}

const LIST_QUERY = `
  query ListInventoryWebhooks {
    webhookSubscriptions(first: 25, topics: [INVENTORY_LEVELS_UPDATE]) {
      edges { node { id topic callbackUrl createdAt } }
    }
  }
`;

const CREATE_MUTATION = `
  mutation CreateInventoryWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      userErrors { field message }
      webhookSubscription { id topic callbackUrl format createdAt }
    }
  }
`;

(async () => {
  console.log(`Store: ${STORE}`);
  console.log(`API:   ${API_VERSION}`);
  console.log(`Topic: ${TOPIC}`);
  console.log(`URL:   ${CALLBACK}\n`);

  const token = await refreshOAuth();

  console.log('Pre-check: any existing INVENTORY_LEVELS_UPDATE subscriptions visible to OAuth app?');
  const pre = await gql(token, LIST_QUERY, {});
  const preEdges = pre.data?.webhookSubscriptions?.edges || [];
  if (preEdges.length === 0) {
    console.log('  none — proceeding with create\n');
  } else {
    console.log('  existing subscriptions:');
    for (const e of preEdges) console.log(`    ${e.node.id}  →  ${e.node.callbackUrl}  (created ${e.node.createdAt})`);
    if (preEdges.some(e => e.node.callbackUrl === CALLBACK)) {
      console.log('\nALREADY REGISTERED — exiting without creating duplicate.');
      process.exit(0);
    }
    console.log();
  }

  console.log('Creating subscription...');
  const res = await gql(token, CREATE_MUTATION, {
    topic: TOPIC,
    sub: { callbackUrl: CALLBACK, format: 'JSON' },
  });

  const payload = res.data?.webhookSubscriptionCreate;
  if (!payload) {
    console.error('Unexpected response:', JSON.stringify(res, null, 2));
    process.exit(1);
  }
  if (payload.userErrors && payload.userErrors.length > 0) {
    console.error('userErrors:', JSON.stringify(payload.userErrors, null, 2));
    process.exit(1);
  }

  const sub = payload.webhookSubscription;
  console.log('\n=== CREATED ===');
  console.log(`  id:          ${sub.id}`);
  console.log(`  topic:       ${sub.topic}`);
  console.log(`  callbackUrl: ${sub.callbackUrl}`);
  console.log(`  format:      ${sub.format}`);
  console.log(`  created:     ${sub.createdAt}`);
})().catch(e => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
