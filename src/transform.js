// Pure transform: raw Shopify orders/create JSON -> clean server purchase event for sGTM /data.
// No side effects (no DB, no network) so it can be unit-tested in isolation.
import crypto from 'node:crypto';
import { normPhone } from './google-ec.js';   // E.164 with billing-country dial code (2026-08-31: shared by EC + Meta legs)

export const clean = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

// E.164 ('+<dial><subscriber>') or null. normPhone resolves the dial code from the billing country; the length
// guard drops fragments (E.164 minimum is 8 digits) so a junk phone never becomes an unmatchable hash.
const e164OrNull = (raw, country) => {
  const e = raw ? normPhone(raw, country) : null;
  return e && e.length >= 9 ? e : null;
};

// Deterministic GA4-format client_id ("int.int") derived from the order id. Used as the LAST-RESORT cid when
// neither the cart-attribute capture nor the checkout-token restore yields a real _ga (true shop.app / consent-denied).
// Stable per order (so retries dedupe) and unique across orders (so each lands as its own user). Such purchases
// count correctly but carry no real session — they surface as direct/unassigned, which is the truthful attribution.
export function syntheticClientId(orderId) {
  const h = crypto.createHash('sha256').update('cid:' + String(orderId)).digest();
  return `${h.readUInt32BE(0)}.${h.readUInt32BE(4)}`;
}

// ---------------------------------------------------------------------------------------------------
// OBSERVABILITY ONLY (2026-09-15). Builds the per-order coverage row that answers one question: did a
// completed order arrive with a usable Shopify scid association? Booleans and categories only - never the
// scid itself, never email/phone, never a hash of either, never customer name or address.
//
// Wallet subtype comes from paymentSubtype() below - explicit evidence only. An earlier version of this
// comment claimed no Shop Pay / Apple Pay / Google Pay discriminator existed; that was wrong for this store,
// which carries Global-e's GE_isApplePay note attribute (confirmed against the Shopify dashboard on a live
// order). `processing_method` is still recorded verbatim when Shopify supplies it - a real Shopify field,
// not an inference.
// Payment/wallet subtype for coverage, from EXPLICIT evidence only. Never inferred from timing, from the
// gateway alone for card wallets, from processing_method, or from behaviour.
//
// Evidence, in priority order:
//   1. a NATIVE Shopify wallet field, probed across the documented shapes. We have not yet confirmed that
//      orders/create carries one - `native_present` is recorded so we can find out from live orders instead
//      of guessing. If it turns out to be present it already wins here.
//   2. Global-e's GE_isApplePay note attribute. Verified on a live JOY order 2026-09-15: the flag read "true"
//      and the Shopify dashboard independently showed "Mastercard via Apple Pay". Only this one GE flag has
//      been observed - no sibling GE_isShopPay / GE_isPayPal has been seen, so none is guessed at.
//   3. the gateway name, but ONLY where the gateway IS the payment method (PayPal, Klarna, Global-e).
//      shopify_payments settles card, Apple Pay, Shop Pay and Google Pay alike, so absent explicit evidence
//      it resolves to `unknown_shopify_payments` - deliberately NOT "card".
//
// If two explicit sources disagree, the disagreement is recorded rather than silently resolved.
export function normaliseWallet(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!v) return null;
  if (v.includes('apple')) return 'apple_pay';
  if (v.includes('google') || v === 'android_pay') return 'google_pay';
  if (v.includes('shop_pay') || v === 'shopify_pay' || v === 'shoppay') return 'shop_pay';
  if (v.includes('paypal')) return 'paypal';
  if (v.includes('klarna')) return 'klarna';
  if (v === 'card' || v === 'credit_card') return 'card';
  return null;
}

export function paymentSubtype(order) {
  try {
    const na = {};
    for (const a of order?.note_attributes || []) { if (a && a.name != null) na[a.name] = a.value; }
    const gw = (Array.isArray(order?.payment_gateway_names) ? order.payment_gateway_names : [])
      .map((g) => String(g || '').toLowerCase());

    // 1. native, if the payload ever carries it
    const txs = Array.isArray(order?.transactions) ? order.transactions : [];
    const nativeRaw =
      order?.payment_details?.credit_card_wallet ??
      order?.payment_details?.wallet ??
      txs.map((t) => t?.payment_details?.credit_card_wallet ?? t?.payment_details?.wallet).find(Boolean) ??
      null;
    const native = normaliseWallet(nativeRaw);

    // 2. Global-e explicit flag
    const ge = String(na.GE_isApplePay ?? '').trim().toLowerCase() === 'true' ? 'apple_pay' : null;

    // 3. gateway, only where the gateway IS the method
    let gwType = null;
    if (gw.some((g) => g.includes('paypal'))) gwType = 'paypal';
    else if (gw.some((g) => g.includes('klarna'))) gwType = 'klarna';
    else if (gw.some((g) => g.includes('global-e') || g.includes('globale'))) gwType = 'global_e';

    const explicit = [...new Set([native, ge].filter(Boolean))];
    const conflict = explicit.length > 1 ? explicit.slice().sort().join('|') : null;

    let subtype = explicit[0] || gwType;
    if (!subtype) {
      subtype = gw.some((g) => g.includes('shopify_payments')) ? 'unknown_shopify_payments'
              : gw.length ? 'other' : null;
    }
    const source = native ? 'native' : ge ? 'globale_note' : gwType ? 'gateway' : 'none';
    return { subtype, source, conflict, native_present: native ? 1 : 0 };
  } catch (e) {
    return { subtype: null, source: 'error', conflict: null, native_present: 0 };
  }
}

export function coverageRecord({ order, orderId, cidSource, sessionSource, applied, otherAttr, ckRow, scidMapped }) {
  const gw = Array.isArray(order?.payment_gateway_names) ? order.payment_gateway_names.join(',') : null;
  const sub = paymentSubtype(order);
  const hasScid = !!(ckRow && ckRow.scid);
  return {
    order_id: String(orderId),
    cid_source: cidSource || null,
    applied: applied ? 1 : 0,
    other_attr: otherAttr ? 1 : 0,
    payment: gw || null,
    source_name: order?.source_name || null,
    session_source: sessionSource || null,
    processing_method: order?.processing_method || null,
    payment_subtype: sub.subtype,
    subtype_source: sub.source,
    subtype_conflict: sub.conflict,
    native_wallet_present: sub.native_present,
    checkout_row: ckRow ? 1 : 0,
    scid_present: hasScid ? 1 : 0,
    scid_mapped: scidMapped === null || scidMapped === undefined ? null : (scidMapped ? 1 : 0),
    created_at: Date.now(),
  };
}

// Observability must NEVER sit on the critical Purchase path. Any failure in the diagnostic write is
// swallowed and reported as false; the caller carries on and the order still emits.
export function logCoverageSafely(writer, rec, onError) {
  try {
    if (typeof writer !== 'function') return false;
    writer(rec);
    return true;
  } catch (e) {
    try { if (typeof onError === 'function') onError(e); } catch (e2) { /* nothing may escape */ }
    return false;
  }
}

// Assemble a Purchase event, including the checkout-beacon scid lookup.
//
// This exists as its own exported function for one reason: index.js cannot be imported under test - it opens
// the volume-backed SQLite database and binds a port on import - so the orchestration around buildEvent() was
// never executed by any test. On 2026-09-15 that let an UNDECLARED identifier (`ckRow`) reach production in
// exactly this path; optional chaining does not guard an undeclared binding, so it throws ReferenceError at
// runtime while parsing cleanly. A parse check cannot catch that. Executing it can.
//
// getCheckoutRow is injected rather than closed over so the "no checkout row" and "lookup throws" cases are
// directly exercisable. Any failure to resolve a scid degrades to null - a Purchase must never be lost
// because the identity lookup had a bad day.
export function assemblePurchaseEvent(order, orderId, applyCid, contentByProductId, sessionObj, getCheckoutRow) {
  let beaconScid = null;
  try {
    const key = String(order?.checkout_token || order?.checkout_id || '');
    const row = typeof getCheckoutRow === 'function' ? getCheckoutRow(key) : null;
    beaconScid = row?.scid || null;
  } catch (e) {
    beaconScid = null;
  }
  return buildEvent(order, orderId, applyCid, contentByProductId, sessionObj, { scid: beaconScid });
}

// Shopify browser id in the form the browse leg (sGTM v22) sends to Meta as external_id.
export function shopifyId(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return undefined;
  return v.slice(0, 4) === 'shp.' ? v : 'shp.' + v;
}
// A genuine GA client id, or undefined. Mirrors the checkout pixel's helper of the same name.
export function realGaExternalId(cid) {
  const t = String(cid == null ? '' : cid).trim();
  return /^[0-9]+\.[0-9]+$/.test(t) ? t : undefined;
}
// Order-preserving de-duplication. gaCid and scid can be the same string when the checkout beacon had no
// _ga cookie and the relay fell back to the Shopify id, so a plain filter(Boolean) would list one key twice.
export function dedupe(list) {
  const out = [];
  for (const v of list) {
    if (v === undefined || v === null) continue;
    const t = String(v).trim();
    if (!t || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}

export function buildEvent(order, orderId, clientId, contentByProductId = {}, session = {}, opts = {}) {
  const na = {};
  for (const { name, value } of order.note_attributes || []) na[name] = value;   // theme snippet writes attribution_*

  const fbclid = na.attribution_fbclid;
  let fbc = na.attribution_fbc;
  if (!fbc && fbclid) fbc = `fb.1.${Date.parse(order.created_at) || Date.now()}.${fbclid}`;  // derive _fbc from fbclid

  const b  = order.billing_address || order.shipping_address || {};
  const cd = order.client_details || {};

  // Identity (2026-08-31 audit): user_data now uses the GA4 user-provided-data schema. This is the ONE shape every
  // consumer reads: the sGTM GA4 tag (UPD -> Google signals/audiences) and the Stape Meta template, which maps
  // em <- user_data.email_address, ph <- user_data.phone_number, fn/ln/ct/st/zp/country <- user_data.address.*.
  // The previous flat keys (city, zip, external_id, fbp, fbc nested here) were silently invisible to Meta.
  // Phone is E.164 via normPhone (billing-country dial code) - Stape only strips non-digits, so a national-format
  // "07..." number would otherwise hash to a value Meta can never match. Unresolvable phones are dropped.
  const country   = (b.country_code || '').toUpperCase() || undefined;
  const email     = order.email || order.contact_email || order.customer?.email;
  const phoneRaw  = order.phone || b.phone || order.customer?.phone;
  const phoneE164 = e164OrNull(phoneRaw, country);
  const address   = clean({ first_name: b.first_name, last_name: b.last_name, city: b.city,
                            region: b.province_code, postal_code: b.zip, country });
  const user_data = clean({
    email_address: email,
    phone_number: phoneE164 || undefined,
    address: Object.keys(address).length ? address : undefined,
    gclid: na.attribution_gclid, gbraid: na.attribution_gbraid,        // click ids kept here for any Google reader
    wbraid: na.attribution_wbraid, msclkid: na.attribution_msclkid,
  });
  // external_id (top-level - the only place the Meta/Pinterest templates read it): the SAME GA client id the browse
  // and checkout legs send (so Meta can stitch the funnel) plus the hashed Shopify customer id for logged-in buyers.
  // Synthetic cids are per-order placeholders and never match anything, so they are excluded.
  // 2026-09-15: admit the GA id to external_id only when it is genuinely GA-shaped. `clientId` here is
  // applyCid, which by default is noteCid - taken straight from the order's note attributes with NO validation
  // (index.js: `const noteCid = na.attribution_ga_cid`). A non-GA value arriving there would otherwise be
  // published to Meta as an identity key. The synthetic exclusion below still has to stay, because
  // syntheticClientId() deliberately MATCHES the GA shape (\d+.\d+) and would pass this test.
  // Note this guards external_id only: `client_id` on line ~129 keeps the resolved cid exactly as before.
  const gaCid    = clientId && clientId !== syntheticClientId(orderId) && realGaExternalId(clientId)
                     ? String(clientId).trim() : undefined;
  const custHash = order.customer?.id ? sha256(String(order.customer.id)) : undefined;
  // 2026-09-15: + the Shopify browser id, so the SERVER copy of Purchase resolves to the same three identity
  // namespaces as the browser copy. Either copy can win Meta's dedup on (event_name, event_id), so both must
  // carry the same set or the funnel stitches only half the time. The id is stored bare in checkout_cid.scid
  // (that column keys the anchor map) and prefixed "shp." only here, because the browse leg sends it that way:
  // excid = "shp." + Shopify visitor id, verified 2026-09-15. Raw, NOT hashed - the Stape Meta template hashes
  // external_id itself and passes an existing 64-hex through, which is exactly how gaCid and custHash already mix.
  const scid     = opts.scid ? shopifyId(opts.scid) : undefined;
  const external_id = dedupe([gaCid, scid, custHash]);

  // GA4 item_id stays the bare VARIANT id. Meta content_ids must equal the catalogue retailer_id, which for JOY is the
  // PRODUCT-level handle path "/products/<handle>#product" (verified against catalogue 929801141125889). The order
  // webhook has no handle, so contentByProductId is the {product_id -> "/products/<handle>#product"} map captured by the
  // checkout pixel and joined here. Fallback to bare variant id only if a product's content id wasn't captured yet.
  const lineItems = (order.line_items || []).map((li) => {
    const variantId = li.variant_id != null ? String(li.variant_id) : '';
    const productId = li.product_id != null ? String(li.product_id) : '';
    // 2026-09-09: Meta catalogue 929801141125889 keys the ad-served items by BARE VARIANT ID (retailer_id = variant id);
    // the "/products/<handle>#product" rows are pixel-created duplicates that no product set uses. content ids = variant id.
    const contentId = variantId || productId;                                 // Meta catalogue match key (bare variant id)
    return {
      variantId, contentId,
      item: clean({
        item_id: variantId || productId,                                     // GA4: prefer variant id; product id only as fallback
        variant_id: variantId || undefined,                                  // Meta contents id (sGTM tag itemIdKey = variant_id)
        item_name: li.name || li.title,
        item_sku: li.sku || undefined,
        price: Number(li.price),
        quantity: li.quantity,
      }),
    };
  });

  const items       = lineItems.map((x) => x.item);                          // GA4 ecommerce shape (variant-keyed)
  const content_ids = [...new Set(lineItems.map((x) => x.contentId).filter(Boolean))];  // Meta content_ids = unique catalogue ids (product-level)
  const contents    = lineItems.map((x) => clean({                           // Meta contents = [{id, quantity, item_price}]
    id: x.contentId || undefined,
    quantity: x.item.quantity,
    item_price: x.item.price,
  }));

  const value = Number(order.subtotal_price);           // ex-shipping, VAT-inclusive — confirm vs native + lock
  const currency = order.currency;

  const eventTime = Math.floor((Date.parse(order.created_at) || Date.now()) / 1000);  // attribute to when the order happened, not when it arrived

  return clean({
    event_name: 'purchase',
    event_id: orderId,                                  // top-level dedup key (= bare numeric order id)
    client_id: clientId || na.attribution_ga_cid,       // resolved cid (note-attr -> checkout-token restore -> synthetic), passed by the caller; falls back to the raw note-attr for safety
    // GA4 session stitching: without session_id a server event spawns a NEW session with no source/medium -> lands as
    // (not set)/direct. Captured from the _ga_<id> cookie at checkout (beacon). Absent for orders with no captured session.
    ga_session_id: session.ga_session_id,
    ga_session_number: session.ga_session_number,
    action_source: 'website',
    event_time: eventTime,                              // unix seconds (Meta event_time; harmless to GA4)
    ip_override: cd.browser_ip || order.browser_ip,     // REAL customer IP, not the server's
    user_agent: cd.user_agent,                          // REAL customer UA
    user_data,
    // top-level fbp/fbc (2026-08-31): the Stape Meta CAPI template resolves these ONLY from the _fbc/_fbp cookies,
    // eventData.common_cookie, or top-level eventData.fbc/eventData.fbp — it never descends into user_data.fbp/fbc.
    // A server-originated hit has no cookies, so the nested copies above were silently dropped (Purchase EMQ showed
    // no fbp row at all, fbc 33%). Kept in user_data too for the GA4/Google tags that read it there.
    fbp: na.attribution_fbp,
    fbc,
    external_id: external_id.length ? external_id : undefined,   // array: [ga_cid, sha256(customer_id)] (CAPI accepts arrays)
    // top-level GA4 purchase params — the sgtmgaaw GA4 tag reads these (it does NOT descend into ecommerce.*)
    transaction_id: orderId,
    value,
    currency,
    items,
    // top-level click ids — the server-side Google Ads conversion tag (sgtmadsct) + Conversion Linker read gclid/
    // gbraid/wbraid from here (cookie-less server context). Absent for cart-bypassing orders -> Google falls back to
    // enhanced conversions from user_data. GA4/Meta ignore these.
    gclid: na.attribution_gclid,
    gbraid: na.attribution_gbraid,
    wbraid: na.attribution_wbraid,
    ecommerce: {                                        // kept for the ed variables (31-47) + Meta/Pinterest templates
      transaction_id: orderId,
      value,
      currency,
      items,
      content_ids,                                      // Meta CAPI: explicit content_ids (bare variant ids)
      content_type: 'product',
      contents,                                         // Meta CAPI: explicit contents [{id, quantity, item_price}]
    },
  });
}

// 2026-09-09: Meta Purchase copy for sGTM /data (single-source cutover). Same event_id (= order id) as the checkout
// pixel's checkout_completed copy so Meta dedups the pair; this is the backstop for express flows where the pixel
// never fires. PRE-HASHED identity (email, phone, first/last name, city, region, zip, country) + external_id
// (sha256 customer id + GA cid), top-level fbp/fbc, event_time = order created_at, value on the same basis as the
// GA4 event. ip_override / user_agent = the CUSTOMER's browser IP/UA from Shopify's order client_details (what
// Shopify's own CAPI sends). Verified 2026-09-09 (Dylan: option 1): Stape's Data Client stamps the REQUEST's IP/UA
// onto any event that arrives without them, i.e. Railway's egress IP + the node UA - so omitting them is worse.
// Click ids / GA session fields dropped (GA4 tag is blocked for this copy).
export function buildMetaPurchase(order, event, { pageLocation, testEventCode } = {}) {
  const id = buildStoredIdentity(order);
  const { gclid, gbraid, wbraid, ga_session_id, ga_session_number, client_id, ...rest } = event;
  const user_data = clean({
    sha256_email_address: id.sha256_email_address,
    sha256_phone_number:  id.sha256_phone_number,
    address: id.address,
  });
  return clean({
    ...rest,
    event_name: 'purchase',
    page_location: pageLocation || 'https://www.joythestore.com/',
    user_data: Object.keys(user_data).length ? user_data : undefined,
    phone: id.sha256_phone_number,                      // top-level: the Stape Meta template reads eventData.phone (64-hex passes through), NOT user_data.sha256_phone_number (verified on JOY-22728)
    test_event_code: testEventCode || undefined,
    meta_copy: 1,                                       // marker for sGTM exceptions / log filtering
  });
}

// refunds/create -> GA4 first-class `refund` event. Built from the (thin) refund webhook alone:
// transaction_id = order_id (same bare-numeric key as the purchase, so GA4 matches it to the original),
// value = sum of refunded line subtotals (ex-shipping, mirrors the purchase value basis), items from refund_line_items.
// No PII: the refund webhook carries no customer identity (Meta/Google legs will need an order-identity join later).
export function buildRefundEvent(refund, identity) {
  const orderId  = String(refund.order_id || '');
  const refundId = String(refund.id || '');
  const rlis = refund.refund_line_items || [];

  const lineItems = rlis.map((rli) => {
    const li = rli.line_item || {};
    const variantId = li.variant_id != null ? String(li.variant_id) : '';
    return {
      variantId,
      item: clean({
        item_id: variantId || (li.product_id != null ? String(li.product_id) : ''),
        item_name: li.name || li.title,
        item_sku: li.sku || undefined,
        price: li.price != null ? Number(li.price) : undefined,
        quantity: rli.quantity,
      }),
    };
  });

  const items       = lineItems.map((x) => x.item);
  const content_ids = lineItems.map((x) => x.variantId).filter(Boolean);
  const contents    = lineItems.map((x) => clean({ id: x.variantId || undefined, quantity: x.item.quantity, item_price: x.item.price }));

  const refundedAmount = rlis.reduce(
    (s, rli) => s + Number(rli.subtotal ?? rli.subtotal_set?.shop_money?.amount ?? 0), 0);
  const value = Number(refundedAmount.toFixed(2));                                 // GA4 refund: items+value present => partial refund supported
  const currency = rlis[0]?.subtotal_set?.shop_money?.currency_code || 'GBP';      // JOY is GBP-only; refund webhook rarely carries a top-level currency
  const eventTime = Math.floor((Date.parse(refund.created_at || refund.processed_at) || Date.now()) / 1000);

  return clean({
    event_name: 'refund',
    event_id: refundId,                                 // dedup the refund SIGNAL on refund id (distinct from the purchase event_id)
    action_source: 'website',
    event_time: eventTime,
    user_data: identity,                                // hashed identity recovered from the order-identity store (GA4 ignores it; Meta/Google use it)
    phone: identity?.sha256_phone_number,               // top-level: Stape reads eventData.phone (64-hex passes through unhashed); it never reads sha256_phone_number
    external_id: identity?.external_id,                 // top-level copies for the Stape Meta template (see buildEvent); identity may be absent for old orders
    fbp: identity?.fbp,
    fbc: identity?.fbc,
    transaction_id: orderId,                            // matches the original purchase (bare numeric)
    value,
    currency,
    items,
    ecommerce: {
      transaction_id: orderId,
      value,
      currency,
      items,
      content_ids,
      content_type: 'product',
      contents,
    },
  });
}

// --- Attribution fallback (2026-08-31) ---
// Merge beacon-captured ad ids (checkout_cid row: fbp / fbc / gclid) into order.note_attributes as attribution_* entries,
// only where the cart capture left nothing (missing OR empty). Returns the list of keys added. Pure; mutates `order`.
export function mergeAttributionFallback(order, row) {
  if (!row) return [];
  const list = order.note_attributes || (order.note_attributes = []);
  const have = {};
  for (const a of list) if (a && a.name) have[a.name] = a.value;
  const added = [];
  for (const [name, value] of [['attribution_fbp', row.fbp], ['attribution_fbc', row.fbc], ['attribution_gclid', row.gclid]]) {
    if (value && !have[name]) { list.push({ name, value: String(value) }); added.push(name); }
  }
  return added;
}

// --- Order-identity store (Option A) ---
// Persist identity at purchase keyed by order id, then join it onto the refund (whose webhook carries no identity).
// Values are SHA-256 hashed with Meta's normalisation (PII minimisation at rest). Because they are PRE-hashed,
// the Meta/Google refund tags must consume them in ALREADY-HASHED mode (do NOT let the tag hash again).
// fbp / fbc / external_id are opaque ids, stored as-is.
const _norm   = (s) => String(s).trim().toLowerCase();

export function buildStoredIdentity(order) {
  const na = {};
  for (const { name, value } of order.note_attributes || []) na[name] = value;
  const fbclid = na.attribution_fbclid;
  let fbc = na.attribution_fbc;
  if (!fbc && fbclid) fbc = `fb.1.${Date.parse(order.created_at) || Date.now()}.${fbclid}`;

  const b = order.billing_address || order.shipping_address || {};
  const email = order.email || order.contact_email || order.customer?.email;
  const phoneRaw = order.phone || b.phone || order.customer?.phone;
  const country = (b.country_code || '').toUpperCase() || undefined;
  const phoneE164 = e164OrNull(phoneRaw, country);                       // 2026-08-31: was bare digits (no dial code) -> unmatchable hash
  const hx = (v, normFn) => (v != null && String(v).trim() !== '') ? sha256(normFn(v)) : undefined;

  // Stored in the GA4 hashed user-provided-data shape (sha256_* keys + address). Stape reads
  // user_data.sha256_email_address and address.sha256_first_name/last_name directly; city/region/postal_code/
  // country are pre-hashed here and pass through its isHashed() check. Phone rides top-level on the refund event.
  const address = clean({
    sha256_first_name: hx(b.first_name, _norm),
    sha256_last_name:  hx(b.last_name, _norm),
    city:              hx(b.city, (s) => _norm(s).replace(/\s+/g, '')),
    region:            hx(b.province_code, _norm),
    postal_code:       hx(b.zip, (s) => _norm(s).replace(/\s+/g, '')),
    country:           hx(b.country_code, _norm),
  });
  return clean({
    sha256_email_address: hx(email, _norm),
    sha256_phone_number:  phoneE164 ? sha256(phoneE164.slice(1)) : undefined,   // Meta normalisation: E.164 digits without '+'
    address: Object.keys(address).length ? address : undefined,
    external_id: order.customer?.id ? sha256(String(order.customer.id)) : undefined,
    fbp: na.attribution_fbp,
    fbc,
  });
}
