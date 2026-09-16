// Execution-level tests for the OBSERVABILITY path. Runs the same functions index.js runs.
// The last group is the important one: a diagnostic failure must never block a Purchase.
import { coverageRecord, logCoverageSafely, assemblePurchaseEvent } from './src/transform.js';

const order = {
  id: 9100, created_at: '2026-09-15T11:00:00Z', checkout_token: 'tok-1',
  email: 'x@y.com', customer: { id: 555 }, line_items: [], note_attributes: [],
  billing_address: { country_code: 'GB', zip: 'L1 1AA', phone: '07700900123' },
  payment_gateway_names: ['shopify_payments'], source_name: 'web', processing_method: 'direct',
};
const U = '3ecfc927-b1a2-4c3d-9e8f-7a1b2c3d4e5f';
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn() ? pass++ : fail++; console.log((fn() ? 'PASS ' : 'FAIL ') + n); }
  catch (e) { fail++; console.log('THREW ' + n + ' -> ' + e.constructor.name + ': ' + e.message); } };

// --- 1. checkout row + scid
t('checkout row WITH scid -> checkout_row=1, scid_present=1', () => {
  const r = coverageRecord({ order, orderId: '9100', cidSource: 'checkout', sessionSource: 'beacon',
    applied: true, otherAttr: false, ckRow: { scid: U, cid: '111.222' }, scidMapped: true });
  return r.checkout_row === 1 && r.scid_present === 1 && r.scid_mapped === 1;
});

// --- 2. checkout row WITHOUT scid
t('checkout row WITHOUT scid -> checkout_row=1, scid_present=0', () => {
  const r = coverageRecord({ order, orderId: '9101', cidSource: 'checkout', sessionSource: 'beacon',
    applied: true, otherAttr: false, ckRow: { cid: '111.222' }, scidMapped: null });
  return r.checkout_row === 1 && r.scid_present === 0 && r.scid_mapped === null;
});

// --- 3. no checkout row at all (the genuine failure cohort)
t('NO checkout row -> checkout_row=0, scid_present=0', () => {
  const r = coverageRecord({ order, orderId: '9102', cidSource: 'synthetic', sessionSource: 'none',
    applied: false, otherAttr: false, ckRow: null, scidMapped: null });
  return r.checkout_row === 0 && r.scid_present === 0;
});

// --- 4. categories recorded, identifiers NOT
t('payment + processing_method + source recorded as categories', () => {
  const r = coverageRecord({ order, orderId: '9103', cidSource: 'checkout', sessionSource: 'beacon',
    applied: true, otherAttr: true, ckRow: { scid: U }, scidMapped: false });
  return r.payment === 'shopify_payments' && r.processing_method === 'direct' && r.source_name === 'web';
});

t('NO raw scid, email, phone, name or address anywhere in the record', () => {
  const r = coverageRecord({ order, orderId: '9104', cidSource: 'checkout', sessionSource: 'beacon',
    applied: true, otherAttr: false, ckRow: { scid: U }, scidMapped: true });
  const blob = JSON.stringify(r);
  return !blob.includes(U) && !blob.includes('x@y.com') && !blob.includes('07700900123')
      && !blob.includes('L1 1AA') && !/[a-f0-9]{64}/.test(blob);
});

t('missing processing_method is not invented', () => {
  const { processing_method, ...rest } = order;
  const r = coverageRecord({ order: rest, orderId: '9105', cidSource: 'checkout', sessionSource: 'beacon',
    applied: true, otherAttr: false, ckRow: { scid: U }, scidMapped: null });
  return r.processing_method === null;
});

// --- 5. OBSERVABILITY MUST NEVER BLOCK PURCHASE
t('logCoverageSafely swallows a throwing writer and returns false', () => {
  let called = false;
  const ok = logCoverageSafely(() => { throw new Error('db is locked'); }, { order_id: '1' }, () => { called = true; });
  return ok === false && called === true;
});

t('logCoverageSafely survives a throwing error handler too', () => {
  const ok = logCoverageSafely(() => { throw new Error('boom'); }, {}, () => { throw new Error('handler also broken'); });
  return ok === false;
});

t('logCoverageSafely tolerates a missing writer', () => logCoverageSafely(undefined, {}) === false);

t('successful write returns true and passes the record through', () => {
  let got = null;
  const ok = logCoverageSafely((rec) => { got = rec; }, { order_id: '9106' });
  return ok === true && got.order_id === '9106';
});

// the decisive one: a broken diagnostic must not stop the Purchase being assembled
t('PURCHASE still assembles when the coverage write throws', () => {
  logCoverageSafely(() => { throw new Error('coverage table gone'); },
    coverageRecord({ order, orderId: '9107', cidSource: 'checkout', sessionSource: 'beacon',
      applied: true, otherAttr: false, ckRow: { scid: U }, scidMapped: true }));
  const ev = assemblePurchaseEvent(order, '9107', '111.222', {}, {}, () => ({ scid: U }));
  return ev && ev.external_id.includes('shp.' + U);
});

t('coverageRecord itself does not throw on a malformed order', () => {
  const r = coverageRecord({ order: null, orderId: '9108', cidSource: null, sessionSource: null,
    applied: false, otherAttr: false, ckRow: undefined, scidMapped: undefined });
  return r.order_id === '9108' && r.payment === null && r.checkout_row === 0;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
