// Google Ads enhanced-conversions uploader (2026-08-28).
// Purpose: conversion action 7519989266 "Google Shopping App Purchase (1)" is app-reported (Shopify Google &
// YouTube channel S2S) so tag-based EC can never see checkout -> 0% EC coverage on the money event. Account-level
// EC is ON with customer-data terms accepted, so API uploads are accepted. This module builds ENHANCEMENT
// ConversionAdjustments keyed on order_id and uploads them via ConversionAdjustmentUploadService (REST, API v23).
//
// Consent gate (HARD): orders whose GE_consentPrefs note attribute explicitly says marketing:"no" are NEVER
// uploaded. Missing/unparseable consent = included (opt-out posture: undecided = allowed; every purchase sent).
//
// Isolation: fully self-contained (own tables, own env). Every entry point catches — a failure here can never
// break the live purchase path. Dormant unless EC_MODE is 'validate' or 'live'.
//
// EC_MODE staging (env change only, no redeploy):
//   off      (default) -> nothing enqueued, sweeper no-op
//   validate -> uploads sent with validateOnly:true (nothing written at Google); rows stay pending so the same
//               orders upload for real once flipped live (until the 24h enhancement window closes)
//   live     -> real uploads
import crypto from 'node:crypto';

const sha256hex = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

// --- Google EC normalisation spec ---
// email: trim, lowercase, and remove periods before the domain for gmail.com/googlemail.com
export function normEmail(email) {
  let e = String(email).trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at > 0) {
    const local = e.slice(0, at), domain = e.slice(at + 1);
    if (domain === 'gmail.com' || domain === 'googlemail.com') e = local.replace(/\./g, '') + '@' + domain;
  }
  return e;
}

// phone: E.164 (+<country><subscriber>). Shopify phones are often national format; use the billing country to
// resolve the dial code for the store's real markets. Unresolvable numbers are dropped (email is the primary
// matcher; a mis-formatted phone hurts match quality more than an absent one).
const DIAL = {
  AD:['376','0'],AE:['971','0'],AF:['93','0'],AG:['1',''],AI:['1',''],AL:['355','0'],AM:['374','0'],AO:['244','0'],
  AR:['54','0'],AS:['1',''],AT:['43','0'],AU:['61','0'],AW:['297','0'],AX:['358','0'],AZ:['994','0'],BA:['387','0'],
  BB:['1',''],BD:['880','0'],BE:['32','0'],BF:['226','0'],BG:['359','0'],BH:['973','0'],BI:['257','0'],BJ:['229','0'],
  BL:['590','0'],BM:['1',''],BN:['673','0'],BO:['591','0'],BQ:['599','0'],BR:['55','0'],BS:['1',''],BT:['975','0'],
  BW:['267','0'],BY:['375','8'],BZ:['501','0'],CA:['1',''],CC:['61','0'],CD:['243','0'],CF:['236','0'],CG:['242','0'],
  CH:['41','0'],CI:['225','0'],CK:['682','0'],CL:['56','0'],CM:['237','0'],CN:['86','0'],CO:['57','0'],CR:['506','0'],
  CU:['53','0'],CV:['238','0'],CW:['599','0'],CX:['61','0'],CY:['357',''],CZ:['420',''],DE:['49','0'],DJ:['253','0'],
  DK:['45',''],DM:['1',''],DO:['1',''],DZ:['213','0'],EC:['593','0'],EE:['372','0'],EG:['20','0'],EH:['212','0'],
  ER:['291','0'],ES:['34',''],ET:['251','0'],FI:['358','0'],FJ:['679','0'],FK:['500','0'],FM:['691','0'],
  FO:['298','0'],FR:['33','0'],GA:['241','0'],GB:['44','0'],GD:['1',''],GE:['995','0'],GF:['594','0'],GG:['44','0'],
  GH:['233','0'],GI:['350','0'],GL:['299','0'],GM:['220','0'],GN:['224','0'],GP:['590','0'],GQ:['240','0'],
  GR:['30',''],GT:['502','0'],GU:['1',''],GW:['245','0'],GY:['592','0'],HK:['852',''],HN:['504','0'],HR:['385','0'],
  HT:['509','0'],HU:['36','06'],ID:['62','0'],IE:['353','0'],IL:['972','0'],IM:['44','0'],IN:['91','0'],
  IO:['246','0'],IQ:['964','0'],IR:['98','0'],IS:['354',''],IT:['39',''],JE:['44','0'],JM:['1',''],JO:['962','0'],
  JP:['81','0'],KE:['254','0'],KG:['996','0'],KH:['855','0'],KI:['686','0'],KM:['269','0'],KN:['1',''],KP:['850','0'],
  KR:['82','0'],KW:['965','0'],KY:['1',''],KZ:['7','8'],LA:['856','0'],LB:['961','0'],LC:['1',''],LI:['423','0'],
  LK:['94','0'],LR:['231','0'],LS:['266','0'],LT:['370','8'],LU:['352',''],LV:['371','0'],LY:['218','0'],
  MA:['212','0'],MC:['377','0'],MD:['373','0'],ME:['382','0'],MF:['590','0'],MG:['261','0'],MH:['692','0'],
  MK:['389','0'],ML:['223','0'],MM:['95','0'],MN:['976','0'],MO:['853',''],MP:['1',''],MQ:['596','0'],MR:['222','0'],
  MS:['1',''],MT:['356',''],MU:['230','0'],MV:['960','0'],MW:['265','0'],MX:['52','0'],MY:['60','0'],MZ:['258','0'],
  NA:['264','0'],NC:['687','0'],NE:['227','0'],NF:['672','0'],NG:['234','0'],NI:['505','0'],NL:['31','0'],
  NO:['47',''],NP:['977','0'],NR:['674','0'],NU:['683','0'],NZ:['64','0'],OM:['968','0'],PA:['507','0'],PE:['51','0'],
  PF:['689','0'],PG:['675','0'],PH:['63','0'],PK:['92','0'],PL:['48','0'],PM:['508','0'],PR:['1',''],PS:['970','0'],
  PT:['351',''],PW:['680','0'],PY:['595','0'],QA:['974','0'],RE:['262','0'],RO:['40','0'],RS:['381','0'],RU:['7','8'],
  RW:['250','0'],SA:['966','0'],SB:['677','0'],SC:['248','0'],SD:['249','0'],SE:['46','0'],SG:['65',''],
  SH:['290','0'],SI:['386','0'],SJ:['47','0'],SK:['421','0'],SL:['232','0'],SM:['378',''],SN:['221','0'],
  SO:['252','0'],SR:['597','0'],SS:['211','0'],ST:['239','0'],SV:['503','0'],SX:['1',''],SY:['963','0'],
  SZ:['268','0'],TC:['1',''],TD:['235','0'],TG:['228','0'],TH:['66','0'],TJ:['992','0'],TK:['690','0'],TL:['670','0'],
  TM:['993','0'],TN:['216','0'],TO:['676','0'],TR:['90','0'],TT:['1',''],TV:['688','0'],TW:['886','0'],TZ:['255','0'],
  UA:['380','0'],UG:['256','0'],US:['1',''],UY:['598','0'],UZ:['998','0'],VA:['379',''],VC:['1',''],VE:['58','0'],
  VG:['1',''],VI:['1',''],VN:['84','0'],VU:['678','0'],WF:['681','0'],WS:['685','0'],XK:['383','0'],YE:['967','0'],
  YT:['262','0'],ZA:['27','0'],ZM:['260','0'],ZW:['263','0']
};

// 2026-09-15: comprehensive country coverage, generated from
// business-data/identity/joy_dial_codes.json (243 ISO 3166-1 countries). Replaces the 19-entry table,
// which returned null for everything else - correct, but it dropped a usable phone for every customer
// outside western Europe/ANZ/North America. Each entry is [dialCode, trunkPrefix]; trunk handling is
// per-country because it is not uniform: most countries strip a leading '0', NANP (+1) has no trunk
// prefix, ITALY's leading '0' is part of the number and must be kept, RU/KZ/BY/LT use '8', HU uses '06'.
// An unknown or missing ISO code still returns null - never guess a dial code.
// Identical logic ships in the JOY checkout pixel and snippets/gtm-datalayer.liquid.
export function normPhone(phone, countryCode) {
  const raw = String(phone == null ? '' : phone).trim();
  let digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (raw.charAt(0) === '+') return '+' + digits;                    // already international
  if (digits.slice(0, 2) === '00') return '+' + digits.slice(2);     // 00-prefixed international
  const e = DIAL[String(countryCode || '').toUpperCase()];
  if (!e) return null;
  const dial = e[0], trunk = e[1];
  if (trunk && digits.slice(0, trunk.length) === trunk) digits = digits.slice(trunk.length);
  if (digits.slice(0, dial.length) === dial && digits.length > 10) return '+' + digits;
  return '+' + dial + digits;
}

const normName = (s) => String(s).trim().toLowerCase();

// consent gate: GE_consentPrefs note attribute, JSON {"marketing":"yes"|"no",...}. Only an EXPLICIT "no" blocks.
// Missing/unparseable = include (Dylan 2026-08-28: every purchase must be sent; matches the opt-out posture where
// undecided = allowed). Explicit denials are NEVER uploaded (EU user consent policy).
export function marketingConsentDenied(na) {
  try {
    const prefs = JSON.parse(na.GE_consentPrefs || '{}');
    return prefs.marketing === 'no';
  } catch { return false; }              // unparseable = treat as undecided, not denied
}

// "2026-08-27T10:27:33+01:00" -> "2026-08-27 10:27:33+01:00" (Google Ads date-time format)
function adsDateTime(iso) {
  const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-]\d{2}:\d{2}|Z)$/);
  if (!m) return null;
  return `${m[1]} ${m[2]}${m[3] === 'Z' ? '+00:00' : m[3]}`;
}

// Build one ENHANCEMENT ConversionAdjustment (REST/camelCase shape) from a raw Shopify order.
// Returns null when the consent gate fails or no usable identifier exists. All PII is hashed HERE, before the
// row is persisted — nothing raw ever sits in the queue.
export function buildEnhancement(order, orderId, { customerId, conversionActionId }) {
  const na = {};
  for (const { name, value } of order.note_attributes || []) na[name] = value;
  if (marketingConsentDenied(na)) return null;                        // HARD gate: explicit "no" never uploads

  const b = order.billing_address || order.shipping_address || {};
  const country = (b.country_code || '').toUpperCase();
  const identifiers = [];

  const email = order.email || order.contact_email || order.customer?.email;
  if (email && String(email).trim()) {
    identifiers.push({ userIdentifierSource: 'FIRST_PARTY', hashedEmail: sha256hex(normEmail(email)) });
  }
  const phoneRaw = order.phone || b.phone || order.customer?.phone;
  if (phoneRaw) {
    const e164 = normPhone(phoneRaw, country);
    if (e164) identifiers.push({ userIdentifierSource: 'FIRST_PARTY', hashedPhoneNumber: sha256hex(e164) });
  }
  if (b.first_name && b.last_name && country && b.zip) {              // addressInfo needs the full quartet
    identifiers.push({
      userIdentifierSource: 'FIRST_PARTY',
      addressInfo: {
        hashedFirstName: sha256hex(normName(b.first_name)),
        hashedLastName: sha256hex(normName(b.last_name)),
        countryCode: country,
        postalCode: String(b.zip).trim(),
      },
    });
  }
  if (!identifiers.length) return null;

  const adj = {
    conversionAction: `customers/${customerId}/conversionActions/${conversionActionId}`,
    adjustmentType: 'ENHANCEMENT',
    orderId: String(orderId),                                          // primary match key vs the channel's S2S conversion
    userIdentifiers: identifiers,
  };
  // secondary match key when a click id was captured: gclid + the order's timestamp
  const dt = adsDateTime(order.created_at);
  if (na.attribution_gclid && dt) adj.gclidDateTimePair = { gclid: na.attribution_gclid, conversionDateTime: dt };
  return adj;
}

// --- Refund adjustments (2026-08-31) ---
// A refund on an EC-tracked order becomes a ConversionAdjustment keyed on the same bare order id:
//   full refund    -> RETRACTION  (value-basis independent: Google zeroes the conversion)
//   partial refund -> RESTATEMENT (adjustedValue = original basis - cumulative refunded)
// Value basis = order.subtotal_price (ex-shipping, VAT-inclusive) - the same basis the relay uses for GA4/Meta and, from
// the one clean daily match we could make, the Shopify Google channel's conversion value. If the channel actually reports
// total incl. shipping, partial restatements under-state by the shipping amount; full refunds are exact either way.
// No PII is sent with an adjustment, so the enhancement consent gate does not apply here.
export function buildRefundAdjustment(refund, orderValue, refundedBefore, { customerId, conversionActionId, mode }) {
  const orderId = String(refund.order_id || '');
  if (!orderId || mode === 'off') return null;
  const thisRefund = (refund.refund_line_items || []).reduce(
    (t, rli) => t + Number(rli.subtotal ?? rli.subtotal_set?.shop_money?.amount ?? 0), 0);
  if (!(thisRefund > 0)) return null;                                        // shipping-only / zero refunds: nothing to restate
  const cumulative = Number(refundedBefore || 0) + thisRefund;
  const dt = adsDateTime(refund.created_at || refund.processed_at) || adsDateTime(new Date().toISOString());
  const base = {
    conversionAction: `customers/${customerId}/conversionActions/${conversionActionId}`,
    orderId,
    adjustmentDateTime: dt,
  };
  const full = orderValue != null && cumulative >= Number(orderValue) - 0.005;
  if (full) return { ...base, adjustmentType: 'RETRACTION', _refunded: thisRefund };
  if (mode !== 'full') return { _skipped: 'partial refund with EC_REFUNDS=' + mode, _refunded: thisRefund };
  if (orderValue == null) return { _skipped: 'partial refund but original order value unknown (pre-2026-08-31 order)', _refunded: thisRefund };
  const adjusted = Math.max(0, Math.round((Number(orderValue) - cumulative) * 100) / 100);
  const currency = refund.refund_line_items?.[0]?.subtotal_set?.shop_money?.currency_code || 'GBP';
  return { ...base, adjustmentType: 'RESTATEMENT', restatementValue: { adjustedValue: adjusted, currencyCode: currency }, _refunded: thisRefund };
}

// Classify a Google Ads partial-failure error into a retry class. Exported for tests.
//   'transient'  - time alone fixes it, long runway. TOO_RECENT belongs here, NOT with not_found: Google returns
//                  it when the conversion was recorded too recently to be adjusted, and it clears as the
//                  conversion ages, so a short ceiling would abandon rows that were about to succeed.
//   'not_found'  - no conversion exists for this conversion action + identifier. Worth a few attempts to cover
//                  propagation; if the original conversion was never uploaded it will never appear.
//   'permanent'  - anything else. Fails immediately, unchanged from previous behaviour.
// TOO_RECENT is tested first so an error text mentioning both does not fall into the short bucket.
// Selection of rows the sweeper will attempt. Exported so the terminal states ('abandoned', 'failed',
// 'expired', 'done') can be tested for exclusion against the real statement rather than a restatement of it.
// Parks refund-adjustment rows that are still pending when EC_REFUNDS=off. Exported so the test exercises the
// real statement: it must touch ONLY pending rows whose key is the refund: namespace, never enhancement rows and
// never rows already in a terminal state.
export const EC_PARK_REFUNDS_SQL = "UPDATE ec_queue SET status='refunds_disabled' WHERE status='pending' AND order_id LIKE 'refund:%'";

export const EC_DUE_SQL = `SELECT order_id, payload, order_created_at, attempts FROM ec_queue WHERE status='pending' AND due_at <= ? ORDER BY due_at LIMIT ?`;

// Decide what happens to a row whose adjustment just failed. Pure, so the ceiling arithmetic is testable.
//   attemptsBefore - ec_queue.attempts as read BEFORE this pass. The attempt just made is attemptsBefore + 1,
//                    which is what the ceiling is compared against: a ceiling of N stops work after the Nth
//                    attempt has failed, so exactly N attempts are made in total.
// Returns { action: 'retry' | 'abandon' | 'fail', kind, attemptsMade, ceiling, why }.
export function ecRetryDecision({ errText, attemptsBefore, ageMs, maxAttempts, notFoundMaxAttempts, maxAgeMs }) {
  const kind = classifyEcError(errText);
  const attemptsMade = Number(attemptsBefore) + 1;
  if (kind === 'permanent') return { action: 'fail', kind, attemptsMade, ceiling: null, why: 'permanent error' };
  const ceiling = kind === 'not_found' ? Number(notFoundMaxAttempts) : Number(maxAttempts);
  if (Number(ageMs) > Number(maxAgeMs)) return { action: 'abandon', kind, attemptsMade, ceiling, why: 'past age ceiling' };
  if (attemptsMade >= ceiling) return { action: 'abandon', kind, attemptsMade, ceiling, why: `${kind} ceiling ${ceiling} attempts reached` };
  return { action: 'retry', kind, attemptsMade, ceiling, why: null };
}

export function classifyEcError(errText) {
  const t = String(errText == null ? '' : errText);
  if (/TOO_RECENT|RESOURCE_EXHAUSTED|CONCURRENT|INTERNAL|TRANSIENT/i.test(t)) return 'transient';
  if (/NOT_FOUND/i.test(t)) return 'not_found';
  return 'permanent';
}

// --- uploader factory: owns the queue tables, OAuth token cache, sweeper and stats ---
export function createEcUploader(db, env = process.env) {
  const {
    EC_MODE = 'off',                        // off | validate | live
    EC_CUSTOMER_ID = '3203754534',          // JOY
    EC_CONVERSION_ACTION_ID = '7519989266', // Google Shopping App Purchase (1)
    EC_UPLOAD_DELAY_MINUTES = 90,           // let the channel's S2S conversion register before enhancing it
    EC_RETRY_MINUTES = 30,                  // partial-failure retry interval (order not yet matchable)
    EC_MAX_AGE_HOURS = 24,                  // Google's enhancement window — expire rows past it
    EC_MAX_ATTEMPTS = 48,                   // ceiling for genuinely transient failures (48 x 30min ≈ the 24h window)
    EC_NOT_FOUND_MAX_ATTEMPTS = 12,         // tighter ceiling for CONVERSION_NOT_FOUND — see classifyEcError below
    EC_BATCH_LIMIT = 200,                   // adjustments per upload request (API max 2000)
    EC_REFUNDS = 'off',                     // off | retract (full refunds -> RETRACTION only) | full (also partial -> RESTATEMENT)
    EC_REFUND_BASIS = 'subtotal',           // subtotal | total — which order value the Shopify Google channel reports as the conversion
                                            // value. Confirm via the Ads 'Order ID' report before using EC_REFUNDS=full; shadow log
                                            // lines '[ec] refund SHADOW' print both candidates for every refund regardless of mode.
    GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  } = env;

  const active = EC_MODE === 'validate' || EC_MODE === 'live';
  const credsOk = !!(GOOGLE_ADS_DEVELOPER_TOKEN && GOOGLE_ADS_CLIENT_ID && GOOGLE_ADS_CLIENT_SECRET && GOOGLE_ADS_REFRESH_TOKEN);
  if (active && !credsOk) console.error('[ec] EC_MODE=' + EC_MODE + ' but Google Ads credentials are missing — uploader disabled');

  db.exec(`CREATE TABLE IF NOT EXISTS ec_queue (
    order_id TEXT PRIMARY KEY, payload TEXT, order_created_at INTEGER, due_at INTEGER,
    attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', last_error TEXT,
    uploaded_at INTEGER, created_at INTEGER)`);
  try { db.exec('ALTER TABLE ec_queue ADD COLUMN order_value REAL'); } catch {}       // 2026-08-31: restatement base (subtotal)
  try { db.exec('ALTER TABLE ec_queue ADD COLUMN order_total REAL'); } catch {}       // 2026-08-31: total incl. shipping (alt basis)
  try { db.exec('ALTER TABLE ec_queue ADD COLUMN refunded_total REAL'); } catch {}    // 2026-08-31: cumulative refunded (partial refunds stack)
  const qInsert  = db.prepare(`INSERT OR IGNORE INTO ec_queue (order_id, payload, order_created_at, due_at, created_at, order_value, order_total) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const qOrder   = db.prepare(`SELECT order_value, order_total, refunded_total FROM ec_queue WHERE order_id = ?`);
  const qRefunded= db.prepare(`UPDATE ec_queue SET refunded_total = COALESCE(refunded_total, 0) + ? WHERE order_id = ?`);
  const qDue     = db.prepare(EC_DUE_SQL);
  const qDone    = db.prepare(`UPDATE ec_queue SET status='done', uploaded_at=?, last_error=NULL WHERE order_id=?`);
  const qRetry   = db.prepare(`UPDATE ec_queue SET due_at=?, attempts=attempts+1, last_error=? WHERE order_id=?`);
  const qFail    = db.prepare(`UPDATE ec_queue SET status=?, last_error=? WHERE order_id=?`);
  const qStats   = db.prepare(`SELECT status, COUNT(*) n, MAX(uploaded_at) last_uploaded FROM ec_queue GROUP BY status`);
  const qLastErr = db.prepare(`SELECT order_id, status, attempts, last_error FROM ec_queue WHERE last_error IS NOT NULL ORDER BY COALESCE(uploaded_at, due_at) DESC LIMIT 5`);
  // 2026-09-16: EC_REFUNDS=off parks any refund-adjustment rows still pending so they stop retrying. Terminal
  // status 'refunds_disabled' is distinct from 'abandoned'/'expired'/'failed' so the rows stay legible as
  // "switched off", not "failed", and remain visible in /health/ec by_status. Reversible: flipping EC_REFUNDS
  // back on does NOT revive them (deliberate — they would be stale); re-queue by hand if ever needed.
  const qParkRefunds = db.prepare(EC_PARK_REFUNDS_SQL);
  const qAband   = db.prepare(`SELECT order_id, attempts, last_error FROM ec_queue WHERE status='abandoned' ORDER BY due_at DESC LIMIT 10`);
  const qPurge   = db.prepare(`DELETE FROM ec_queue WHERE status != 'pending' AND created_at < ?`);

  if (EC_REFUNDS === 'off') {
    try {
      const parked = qParkRefunds.run().changes;
      if (parked) console.log('[ec] EC_REFUNDS=off — parked ' + parked + ' pending refund-adjustment row(s) as refunds_disabled');
    } catch (e) { console.error('[ec] parking pending refund rows failed', e.message); }
  }

  // OAuth access-token cache (refresh-token grant; Google Ads refresh tokens do not rotate)
  let token = null, tokenExp = 0;
  async function accessToken() {
    if (token && Date.now() < tokenExp - 60000) return token;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
        client_id: GOOGLE_ADS_CLIENT_ID, client_secret: GOOGLE_ADS_CLIENT_SECRET,
      }),
    });
    if (!r.ok) throw new Error(`oauth ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    token = j.access_token; tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
    return token;
  }

  // enqueue from the orders-create webhook. Never throws.
  function enqueue(order, orderId) {
    if (!active) return;
    try {
      const adj = buildEnhancement(order, orderId, { customerId: EC_CUSTOMER_ID, conversionActionId: EC_CONVERSION_ACTION_ID });
      if (!adj) { console.log('[ec] skip (consent explicitly denied, or no identifiers)', orderId); return; }
      const createdMs = Date.parse(order.created_at) || Date.now();
      const r = qInsert.run(orderId, JSON.stringify(adj), createdMs,
        Date.now() + Number(EC_UPLOAD_DELAY_MINUTES) * 60000, Date.now(),
        Number.isFinite(Number(order.subtotal_price)) ? Number(order.subtotal_price) : null,
        Number.isFinite(Number(order.total_price)) ? Number(order.total_price) : null);
      if (r.changes) console.log('[ec] queued', orderId, 'identifiers=' + adj.userIdentifiers.length, 'gclid=' + (adj.gclidDateTimePair ? 'y' : 'n'));
    } catch (e) { console.error('[ec] enqueue failed', orderId, e.message); }
  }

  // refunds/create -> RETRACTION / RESTATEMENT row (key refund:<refundId>, so it rides the same sweeper and never
  // collides with the order's enhancement row). order_created_at = now so the 24h enhancement expiry never bites it.
  function enqueueRefund(refund) {
    if (!active) return;
    try {
      const orderId = String(refund.order_id || ''), refundId = String(refund.id || '');
      if (!orderId || !refundId) return;
      const row = qOrder.get(orderId);                       // absent for orders before the uploader existed
      // SHADOW (always, every mode): what a partial restatement would send under each basis, so the basis can be
      // proven against the Ads Order ID report before EC_REFUNDS=full is ever set. Sends nothing.
      try {
        const refunded = (refund.refund_line_items || []).reduce((t, r) => t + Number(r.subtotal ?? r.subtotal_set?.shop_money?.amount ?? 0), 0);
        const before = Number(row?.refunded_total ?? 0);
        const sub = row?.order_value ?? null, tot = row?.order_total ?? null;
        const adjSub = sub != null ? Math.max(0, Math.round((sub - before - refunded) * 100) / 100) : null;
        const adjTot = tot != null ? Math.max(0, Math.round((tot - before - refunded) * 100) / 100) : null;
        console.log('[ec] refund SHADOW order', orderId, 'refund', refundId, 'refunded_goods=' + refunded.toFixed(2),
          'prior_refunded=' + before.toFixed(2), 'subtotal_basis=' + (sub ?? '?'), '-> adjusted=' + (adjSub ?? '?'),
          '| total_basis=' + (tot ?? '?'), '-> adjusted=' + (adjTot ?? '?'), '| mode=' + EC_REFUNDS, 'basis=' + EC_REFUND_BASIS);
      } catch {}
      if (EC_REFUNDS === 'off') return;
      const base = EC_REFUND_BASIS === 'total' ? (row?.order_total ?? null) : (row?.order_value ?? null);
      const adj = buildRefundAdjustment(refund, base, row?.refunded_total ?? 0,
        { customerId: EC_CUSTOMER_ID, conversionActionId: EC_CONVERSION_ACTION_ID, mode: EC_REFUNDS });
      if (!adj) { console.log('[ec] refund ignored (no restatable value)', refundId, 'order', orderId); return; }
      if (adj._skipped) { console.log('[ec] refund skipped:', adj._skipped, refundId, 'order', orderId); return; }
      const { _refunded, ...payload } = adj;
      const r = qInsert.run(`refund:${refundId}`, JSON.stringify(payload), Date.now(), Date.now() + 5 * 60000, Date.now(), null, null);
      if (r.changes) {
        if (row) qRefunded.run(_refunded, orderId);
        console.log('[ec] refund queued', refundId, 'order', orderId, payload.adjustmentType,
          payload.restatementValue ? 'adjusted=' + payload.restatementValue.adjustedValue : '');
      }
    } catch (e) { console.error('[ec] enqueueRefund failed', e.message); }
  }

  // one upload pass over due rows. Batched; partial-failure aware; validateOnly in validate mode.
  async function sweep() {
    if (!active || !credsOk) return;
    let rows;
    try { rows = qDue.all(Date.now(), Number(EC_BATCH_LIMIT)); } catch (e) { console.error('[ec] queue read failed', e.message); return; }
    if (!rows.length) return;

    // expire anything past the enhancement window before it goes on the wire
    const maxAgeMs = Number(EC_MAX_AGE_HOURS) * 3600000;
    const live = [];
    for (const row of rows) {
      // refund adjustments switched off: park rather than upload. Catches any row whose due_at came round
      // between the flag flipping and the init-time parking pass.
      if (EC_REFUNDS === 'off' && String(row.order_id).startsWith('refund:')) {
        qFail.run('refunds_disabled', 'EC_REFUNDS=off', row.order_id);
        continue;
      }
      if (Date.now() - row.order_created_at > maxAgeMs) {
        qFail.run('expired', `past ${EC_MAX_AGE_HOURS}h enhancement window`, row.order_id);
        console.error('[ec] expired unuploaded', row.order_id);
      } else live.push(row);
    }
    if (!live.length) return;

    const validateOnly = EC_MODE === 'validate';
    let resp, body;
    try {
      const tok = await accessToken();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
        'developer-token': GOOGLE_ADS_DEVELOPER_TOKEN,
      };
      if (GOOGLE_ADS_LOGIN_CUSTOMER_ID) headers['login-customer-id'] = String(GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/-/g, '');
      resp = await fetch(`https://googleads.googleapis.com/v23/customers/${EC_CUSTOMER_ID}:uploadConversionAdjustments`, {
        method: 'POST', headers,
        body: JSON.stringify({
          conversionAdjustments: live.map((r) => JSON.parse(r.payload)),
          partialFailure: true,
          validateOnly,
        }),
      });
      body = await resp.json().catch(() => ({}));
    } catch (e) {
      // transport failure: whole batch retries on the next sweep (rows untouched, still pending+due)
      console.error('[ec] upload transport failed', e.message);
      return;
    }

    if (!resp.ok) {
      // request-level rejection (auth, quota, malformed): log loudly, back the whole batch off
      const msg = JSON.stringify(body?.error || body).slice(0, 500);
      console.error('[ec] upload rejected HTTP', resp.status, msg);
      for (const row of live) qRetry.run(Date.now() + Number(EC_RETRY_MINUTES) * 60000, `HTTP ${resp.status}: ${msg.slice(0, 200)}`, row.order_id);
      return;
    }

    // partial-failure mapping: fieldPathElements -> conversion_adjustments[index]
    const errByIndex = {};
    const pf = body.partialFailureError;
    if (pf) {
      for (const d of pf.details || []) {
        for (const err of d.errors || []) {
          const el = (err.location?.fieldPathElements || []).find((p) => p.fieldName === 'conversion_adjustments');
          const code = JSON.stringify(err.errorCode || {});
          const text = `${code} ${err.message || ''}`.trim();
          if (el != null && el.index != null) errByIndex[el.index] = text;
          else console.error('[ec] partial-failure (unmapped)', text);
        }
      }
    }

    let ok = 0, retried = 0, failed = 0;
    live.forEach((row, i) => {
      const errText = errByIndex[i];
      if (!errText) {
        if (validateOnly) {
          // validation clean: keep pending so the flip to live re-uploads for real; recheck in EC_RETRY_MINUTES
          qRetry.run(Date.now() + Number(EC_RETRY_MINUTES) * 60000, null, row.order_id);
          console.log('[ec] VALIDATED clean', row.order_id);
        } else {
          qDone.run(Date.now(), row.order_id);
        }
        ok++;
        return;
      }
      // Retry policy. 'transient' is a failure that time alone fixes, so it gets the long runway: TOO_RECENT is
      // Google refusing to adjust a conversion it only just recorded, which clears once the conversion ages, so it
      // must NOT share the short CONVERSION_NOT_FOUND ceiling. 'not_found' means no conversion exists for this
      // action + identifier: if the original was never uploaded it never appears, so a handful of attempts covers
      // propagation and anything beyond that is burnt API calls (2026-09-15: one refund retried ~37 times).
      // Both ceilings sit UNDER the existing EC_MAX_AGE_HOURS expiry — that is Google's enhancement window and
      // stays the outer bound; these only stop useless work sooner.
      const d = ecRetryDecision({
        errText,
        attemptsBefore: row.attempts,
        ageMs: Date.now() - row.order_created_at,
        maxAttempts: EC_MAX_ATTEMPTS,
        notFoundMaxAttempts: EC_NOT_FOUND_MAX_ATTEMPTS,
        maxAgeMs: Number(EC_MAX_AGE_HOURS) * 3600000,
      });
      if (d.action === 'fail') {
        qFail.run('failed', errText.slice(0, 300), row.order_id); failed++;
        console.error('[ec] adjustment error', row.order_id, '(permanent)', errText.slice(0, 300));
      } else if (d.action === 'abandon') {
        qFail.run('abandoned', `[abandoned: ${d.why}] ${errText}`.slice(0, 300), row.order_id); failed++;
        console.error('[ec] adjustment abandoned', row.order_id, `(${d.why}, attempts=${d.attemptsMade})`, errText.slice(0, 200));
      } else {
        qRetry.run(Date.now() + Number(EC_RETRY_MINUTES) * 60000, errText.slice(0, 300), row.order_id); retried++;
        console.error('[ec] adjustment error', row.order_id, `(will retry, attempt ${d.attemptsMade}/${d.ceiling})`, errText.slice(0, 300));
      }
    });
    console.log(`[ec] upload ${validateOnly ? 'VALIDATE' : 'LIVE'} batch=${live.length} ok=${ok} retry=${retried} failed=${failed} partial_failure=${pf ? 'YES' : 'none'}`);
    try { qPurge.run(Date.now() - 60 * 86400000); } catch {}   // 60d: order_value must outlive the refund window
  }

  function stats() {
    try {
      return {
        mode: EC_MODE, refunds: EC_REFUNDS, refund_basis: EC_REFUND_BASIS, creds_present: credsOk,
        conversion_action: EC_CONVERSION_ACTION_ID, customer_id: EC_CUSTOMER_ID,
        by_status: qStats.all(),
        abandoned: qAband.all(),          // terminal: ceiling or age reached — visible, never silently dropped
        recent_errors: qLastErr.all(),
      };
    } catch (e) { return { mode: EC_MODE, error: e.message }; }
  }

  return { enqueue, enqueueRefund, sweep, stats, active };
}
