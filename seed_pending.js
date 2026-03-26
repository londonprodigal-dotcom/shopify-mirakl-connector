// One-shot script to seed pending import into Postgres
// Run via: node seed_pending.js
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const pending = {
  importId: 4713700,
  offersCsvPath: 'output/2026-03-26T06-49-11-offers.csv',
  uploadedAt: '2026-03-26T06:49:13.000Z'
};
(async () => {
  await pool.query(
    "INSERT INTO sync_state (key, value) VALUES ('pending_product_import', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
    [JSON.stringify(pending)]
  );
  console.log('Seeded pending import:', pending.importId);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
