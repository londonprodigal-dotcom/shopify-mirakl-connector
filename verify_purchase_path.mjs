// Integration test for the ACTUAL Purchase orchestration the webhook runs.
// index.js calls assemblePurchaseEvent(...) and so does this file - same function, same arguments shape.
// Covers the 2026-09-15 regression class: an identifier in this path that parses but throws at runtime.
import { assemblePurchaseEvent, shopifyId } from './src/transform.js';
import crypto from 'node:crypto';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const U = '3ecfc927-b1a2-4c3d-9e8f-7a1b2c3d4e5f';

const order = {
  id: 9001, created_at: '2026-09-15T10:30:00Z', checkout_token: 'tok-abc',
  email: 'Test.User@Example.com', phone: '07700900123',
  customer: { id: 555, email: 'Test.User@Example.com' },
  billing_address: { first_name: 'A', last_name: 'B', city: 'Liverpool', province_code: 'ENG',
                     zip: 'L17 9PR', country_code: 'GB', phone: '07700900123' },
  line_items: [], note_attributes: [],
};

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { const ok = fn(); ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name); }
  catch (e) { fail++; console.log('THREW ' + name + '  -> ' + e.constructor.name + ': ' + e.message); }
};

// The exact failure mode that reached production: this must not throw.
t('order WITH a checkout row reaches buildEvent and carries shp.<uuid>', () => {
  const ev = assemblePurchaseEvent(order, '9001', '111.222', {}, {}, (tok) => tok === 'tok-abc' ? { scid: U } : undefined);
  return ev && ev.external_id.includes('shp.' + U) && ev.external_id[0] === '111.222' && ev.external_id.includes(sha('555'));
});

t('order WITHOUT a checkout row reaches buildEvent and does NOT throw', () => {
  const ev = assemblePurchaseEvent(order, '9002', '111.222', {}, {}, () => undefined);
  return ev && !ev.external_id.some((v) => String(v).startsWith('shp.')) && ev.external_id[0] === '111.222';
});

t('checkout row exists but has a null scid', () => {
  const ev = assemblePurchaseEvent(order, '9003', '111.222', {}, {}, () => ({ scid: null, cid: '111.222' }));
  return ev && !ev.external_id.some((v) => String(v).startsWith('shp.'));
});

t('lookup THROWS -> degrades to null, purchase still assembled', () => {
  const ev = assemblePurchaseEvent(order, '9004', '111.222', {}, {}, () => { throw new Error('db locked'); });
  return ev && ev.external_id[0] === '111.222';
});

t('lookup not supplied at all (undefined) -> no throw', () => {
  const ev = assemblePurchaseEvent(order, '9005', '111.222', {}, {}, undefined);
  return ev && ev.external_id[0] === '111.222';
});

t('order with no checkout_token or checkout_id -> no throw', () => {
  const bare = { ...order, checkout_token: undefined, checkout_id: undefined };
  const ev = assemblePurchaseEvent(bare, '9006', '111.222', {}, {}, (tok) => (tok === '' ? undefined : { scid: U }));
  return ev && !ev.external_id.some((v) => String(v).startsWith('shp.'));
});

t('scid arriving already shp.-prefixed is not double-prefixed', () => {
  const ev = assemblePurchaseEvent(order, '9007', '111.222', {}, {}, () => ({ scid: 'shp.' + U }));
  return ev.external_id.includes('shp.' + U) && !ev.external_id.some((v) => String(v).startsWith('shp.shp.'));
});

t('no GA cid at all (first-session browser) -> [shp.<uuid>, custHash]', () => {
  const ev = assemblePurchaseEvent(order, '9008', undefined, {}, {}, () => ({ scid: U }));
  return JSON.stringify(ev.external_id) === JSON.stringify(['shp.' + U, sha('555')]);
});

t('em/ph/address survive the orchestration unchanged', () => {
  const ev = assemblePurchaseEvent(order, '9009', '111.222', {}, {}, () => ({ scid: U }));
  return ev.user_data.email_address === 'Test.User@Example.com'
      && ev.user_data.phone_number === '+447700900123'
      && ev.user_data.address.postal_code === 'L17 9PR';
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
