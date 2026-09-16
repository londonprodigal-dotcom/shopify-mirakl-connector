// Execution-level tests for payment_subtype. Explicit evidence only - never guessed.
import { paymentSubtype, coverageRecord, logCoverageSafely, assemblePurchaseEvent, normaliseWallet } from './src/transform.js';
const U = '3ecfc927-b1a2-4c3d-9e8f-7a1b2c3d4e5f';
const base = {
  id: 1, created_at: '2026-09-15T12:03:21Z', checkout_token: 'tok', email: 'a@b.com',
  customer: { id: 9 }, line_items: [], note_attributes: [],
  billing_address: { country_code: 'GB', zip: 'LS13 3PG', phone: '07913908778' },
  payment_gateway_names: ['shopify_payments'], source_name: 'web',
};
const na = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
let pass = 0, fail = 0;
const t = (n, fn) => { let ok = false; try { ok = fn(); } catch (e) { console.log('THREW ' + n + ' -> ' + e.message); }
  ok ? pass++ : fail++; if (!(ok)) console.log('FAIL ' + n); else console.log('PASS ' + n); };

// --- the real JOY Apple Pay shape, as observed on order #JOY-22790
t('GE_isApplePay=true -> apple_pay (source globale_note)', () => {
  const o = { ...base, note_attributes: na({ GE_isApplePay: 'true', GE_clientId: 'x', attribution_ga_cid: '1.2' }) };
  const r = paymentSubtype(o);
  return r.subtype === 'apple_pay' && r.source === 'globale_note' && r.conflict === null;
});
t('GE_isApplePay="false" -> NOT apple_pay', () => paymentSubtype({ ...base, note_attributes: na({ GE_isApplePay: 'false' }) }).subtype === 'unknown_shopify_payments');

// --- no explicit signal must NOT be guessed as card
t('shopify_payments, no wallet evidence -> unknown_shopify_payments (never card)', () => {
  const r = paymentSubtype(base);
  return r.subtype === 'unknown_shopify_payments' && r.source === 'none' && r.subtype !== 'card';
});

// --- gateway IS the method
t('paypal gateway -> paypal', () => paymentSubtype({ ...base, payment_gateway_names: ['paypal'] }).subtype === 'paypal');
t('Klarna gateway -> klarna', () => paymentSubtype({ ...base, payment_gateway_names: ['Klarna'] }).subtype === 'klarna');
t('Global-e gateway -> global_e', () => paymentSubtype({ ...base, payment_gateway_names: ['Global-e Onsite Payments'] }).subtype === 'global_e');

// --- native field wins when present, and is flagged
t('native wallet field wins over gateway, native_present=1', () => {
  const r = paymentSubtype({ ...base, payment_details: { credit_card_wallet: 'apple_pay' } });
  return r.subtype === 'apple_pay' && r.source === 'native' && r.native_present === 1;
});
t('native on a transaction is found too', () => {
  const r = paymentSubtype({ ...base, transactions: [{ payment_details: { wallet: 'shopify_pay' } }] });
  return r.subtype === 'shop_pay' && r.source === 'native';
});
t('native_present=0 when no native field exists', () => paymentSubtype({ ...base, note_attributes: na({ GE_isApplePay: 'true' }) }).native_present === 0);

// --- conflict recorded, not silently resolved
t('two explicit sources disagreeing -> conflict recorded', () => {
  const r = paymentSubtype({ ...base, payment_details: { wallet: 'google_pay' }, note_attributes: na({ GE_isApplePay: 'true' }) });
  return r.conflict === 'apple_pay|google_pay' && r.subtype === 'google_pay';   // native wins, conflict kept
});

// --- robustness
t('malformed note_attributes do not throw', () => {
  for (const bad of [null, undefined, 'nope', [null], [{}], [{ name: null, value: 1 }]]) {
    const r = paymentSubtype({ ...base, note_attributes: bad });
    if (typeof r.subtype === 'undefined') return false;
  }
  return true;
});
t('null order does not throw', () => paymentSubtype(null).source === 'none' || paymentSubtype(null).source === 'error');
t('no gateway at all -> null subtype, not a guess', () => paymentSubtype({ ...base, payment_gateway_names: [] }).subtype === null);
t('normaliseWallet only maps evidenced values', () =>
  normaliseWallet('APPLE PAY') === 'apple_pay' && normaliseWallet('Shopify Pay') === 'shop_pay'
  && normaliseWallet('') === null && normaliseWallet('mastercard') === null);

// --- privacy assertion over the serialised row (unchanged constraint)
t('serialised coverage row still carries no identifiers', () => {
  const o = { ...base, note_attributes: na({ GE_isApplePay: 'true', GE_clientId: '3e3e152c-8a8d-4f8a-98fc-ad374cc24791' }) };
  const rec = coverageRecord({ order: o, orderId: '1', cidSource: 'checkout', sessionSource: 'beacon',
    applied: true, otherAttr: false, ckRow: { scid: U }, scidMapped: true });
  const blob = JSON.stringify(rec);
  return rec.payment_subtype === 'apple_pay'
      && !blob.includes(U) && !blob.includes('a@b.com') && !blob.includes('07913908778')
      && !blob.includes('LS13 3PG') && !blob.includes('3e3e152c') && !/[a-f0-9]{64}/.test(blob);
});

// --- subtype logging failure cannot affect Purchase
t('PURCHASE still assembles when subtype logging throws', () => {
  logCoverageSafely(() => { throw new Error('coverage gone'); },
    coverageRecord({ order: { ...base, note_attributes: na({ GE_isApplePay: 'true' }) }, orderId: '2',
      cidSource: 'checkout', sessionSource: 'beacon', applied: true, otherAttr: false,
      ckRow: { scid: U }, scidMapped: true }));
  const ev = assemblePurchaseEvent(base, '2', '111.222', {}, {}, () => ({ scid: U }));
  return ev && ev.external_id.includes('shp.' + U);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
