// Local verification of the pure transform functions (2026-08-31 identity-schema patch). Run: node verify_transform.mjs
import { buildEvent, buildStoredIdentity, buildRefundEvent, syntheticClientId } from './src/transform.js';

const base = {
  id: 1, created_at: '2026-08-31T05:00:00Z', email: 'Test.User@Example.com', phone: '07700 900123',
  subtotal_price: '50.00', currency: 'GBP', customer: { id: 12345 },
  client_details: { browser_ip: '1.2.3.4', user_agent: 'UA' },
  note_attributes: [
    { name: 'attribution_fbp', value: 'fb.1.1756600000000.123456' },
    { name: 'attribution_fbclid', value: 'IwZXh0' },
    { name: 'attribution_gclid', value: 'gcl123' },
  ],
  billing_address: { first_name: 'A', last_name: 'B', city: 'Liverpool', province_code: 'ENG', zip: 'L17 9PR', country_code: 'GB' },
  line_items: [{ variant_id: 11, product_id: 22, name: 'X', price: '50.00', quantity: 1 }],
};

let fails = 0;
const check = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fails++; };

const ev = buildEvent(base, '1', '111.222', {}, {});
console.log('user_data =', JSON.stringify(ev.user_data));
console.log('external_id =', JSON.stringify(ev.external_id), '| fbp =', ev.fbp, '| fbc =', ev.fbc, '| gclid top =', ev.gclid);
check('email_address present', ev.user_data.email_address === 'Test.User@Example.com');
check('national phone -> E.164', ev.user_data.phone_number === '+447700900123');
check('address quartet + city/region', ev.user_data.address.postal_code === 'L17 9PR' && ev.user_data.address.city === 'Liverpool' && ev.user_data.address.country === 'GB');
check('external_id = [ga_cid, sha256(customer)]', Array.isArray(ev.external_id) && ev.external_id[0] === '111.222' && /^[0-9a-f]{64}$/.test(ev.external_id[1]));
check('top-level fbp/fbc kept', ev.fbp === 'fb.1.1756600000000.123456' && ev.fbc.startsWith('fb.1.'));
check('old flat keys gone', !('email' in ev.user_data) && !('zip' in ev.user_data) && !('customer_id' in ev.user_data));
check('GA4 params untouched', ev.transaction_id === '1' && ev.value === 50 && ev.items.length === 1 && ev.ecommerce.contents.length === 1);

const intl = buildEvent({ ...base, phone: '+44 7700 900123' }, '2', '111.222', {}, {});
check('E.164 input unchanged', intl.user_data.phone_number === '+447700900123');

const syn = buildEvent({ ...base, customer: undefined, phone: '12', note_attributes: [] }, '3', syntheticClientId('3'), {}, {});
console.log('guest/synthetic/bad-phone user_data =', JSON.stringify(syn.user_data));
check('synthetic cid + guest -> no external_id key', !('external_id' in syn));
check('unresolvable phone dropped', !('phone_number' in syn.user_data));
check('no attributes -> no fbp/fbc keys', !('fbp' in syn) && !('fbc' in syn));

const id = buildStoredIdentity(base);
console.log('stored identity keys =', Object.keys(id).join(','), '| address keys =', Object.keys(id.address).join(','));
check('identity phone hashed on Meta form (44...)', /^[0-9a-f]{64}$/.test(id.sha256_phone_number));
check('identity has no raw PII', JSON.stringify(id).indexOf('Liverpool') === -1 && JSON.stringify(id).indexOf('Example') === -1);

const refund = { id: 9, order_id: 1, created_at: '2026-08-31T06:00:00Z',
  refund_line_items: [{ quantity: 1, subtotal: '50.00', line_item: { variant_id: 11, name: 'X', price: '50.00' } }] };
const rf = buildRefundEvent(refund, id);
check('refund carries top-level phone/external_id/fbp', rf.phone === id.sha256_phone_number && rf.external_id === id.external_id && rf.fbp === id.fbp);
const rf0 = buildRefundEvent({ ...refund, refund_line_items: [] }, undefined);
check('refund with NO identity does not throw', rf0.event_name === 'refund' && !('fbp' in rf0) && !('phone' in rf0));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
