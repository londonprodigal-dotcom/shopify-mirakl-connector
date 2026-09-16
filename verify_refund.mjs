// Local verification: beacon attribution fallback + Google EC refund adjustments (2026-08-31). Run: node verify_refund.mjs
import { mergeAttributionFallback } from './src/transform.js';
import { buildRefundAdjustment } from './src/google-ec.js';

let fails = 0;
const check = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fails++; };

// --- attribution fallback ---
const row = { fbp: 'fb.1.1756600000000.111', fbc: 'fb.1.1756600000001.IwAR', gclid: 'Cj0KCQjw_abc123' };
const o1 = { note_attributes: [{ name: 'attribution_fbp', value: 'fb.1.1.999' }, { name: 'attribution_gclid', value: '' }] };
const added1 = mergeAttributionFallback(o1, row);
check('existing fbp kept, empty gclid + missing fbc filled', added1.join(',') === 'attribution_fbc,attribution_gclid'
  && o1.note_attributes.find(a => a.name === 'attribution_fbp').value === 'fb.1.1.999'
  && o1.note_attributes.filter(a => a.name === 'attribution_gclid').some(a => a.value === row.gclid));
const o2 = {};
check('no note_attributes at all -> all three added', mergeAttributionFallback(o2, row).length === 3 && o2.note_attributes.length === 3);
check('no beacon row -> nothing added', mergeAttributionFallback({ note_attributes: [] }, undefined).length === 0);
check('row without ids -> nothing added', mergeAttributionFallback({}, { cid: '1.2' }).length === 0);

// --- refund adjustments ---
const ids = { customerId: '3203754534', conversionActionId: '7519989266' };
const refund = (lines, id = 9) => ({ id, order_id: 17194393403779, created_at: '2026-08-31T07:00:00+01:00',
  refund_line_items: lines.map(v => ({ subtotal: String(v), subtotal_set: { shop_money: { amount: String(v), currency_code: 'GBP' } } })) });

check('EC_REFUNDS=off -> null', buildRefundAdjustment(refund([32]), 32, 0, { ...ids, mode: 'retract' }) !== null
  && buildRefundAdjustment(refund([32]), 32, 0, { ...ids, mode: 'off' }) === null);
const full = buildRefundAdjustment(refund([32]), 32, 0, { ...ids, mode: 'retract' });
check('full refund -> RETRACTION keyed on order id', full.adjustmentType === 'RETRACTION' && full.orderId === '17194393403779'
  && full.adjustmentDateTime === '2026-08-31 07:00:00+01:00' && full.conversionAction.endsWith('/7519989266') && !('restatementValue' in full));
const partialRetractMode = buildRefundAdjustment(refund([10]), 32, 0, { ...ids, mode: 'retract' });
check('partial refund in retract mode -> skipped (not sent)', partialRetractMode && partialRetractMode._skipped && !partialRetractMode.adjustmentType);
const partial = buildRefundAdjustment(refund([10]), 32, 0, { ...ids, mode: 'full' });
check('partial refund in full mode -> RESTATEMENT 22.00 GBP', partial.adjustmentType === 'RESTATEMENT'
  && partial.restatementValue.adjustedValue === 22 && partial.restatementValue.currencyCode === 'GBP');
const second = buildRefundAdjustment(refund([22], 10), 32, 10, { ...ids, mode: 'full' });
check('second partial that completes the refund -> RETRACTION', second.adjustmentType === 'RETRACTION');
const stacked = buildRefundAdjustment(refund([5], 11), 32, 10, { ...ids, mode: 'full' });
check('stacked partial uses cumulative (32-15=17)', stacked.adjustmentType === 'RESTATEMENT' && stacked.restatementValue.adjustedValue === 17);
const unknownBase = buildRefundAdjustment(refund([10]), null, 0, { ...ids, mode: 'full' });
check('partial with unknown order value -> skipped, never guesses', unknownBase._skipped && !unknownBase.adjustmentType);
check('shipping-only refund (no line items) -> null', buildRefundAdjustment(refund([]), 32, 0, { ...ids, mode: 'full' }) === null);
check('no PII in any adjustment', !JSON.stringify(full).match(/email|phone|hashed/i) && !JSON.stringify(partial).match(/email|phone|hashed/i));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
