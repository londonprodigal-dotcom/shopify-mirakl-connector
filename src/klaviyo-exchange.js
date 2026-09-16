// Klaviyo identity exchange (2026-08-28). Resolves a Klaviyo _kx URL param (email-click exchange id) or the
// $exchange_id inside the __kla_id cookie to the profile's email, SHA-256 hashed SERVER-SIDE. The raw email
// NEVER leaves this process — the browser receives only the hash, which it stores as the joy_em_sha256 cookie
// (same value/format the theme's v1/v2/v5 capture paths write), so Klaviyo subscribers who never bought get
// recognised on browse events (Meta EMQ email on VC/ATC/IC).
//
// Follows the google-ec.js patterns: self-contained module, own SQLite table, every entry point caught,
// dormant without its credential. Isolation: can never break the purchase path.
//
// Abuse posture: the endpoint is an oracle only for callers already holding a valid Klaviyo exchange token,
// and answers only with a salt-free SHA-256 of the email (what the site already exposes client-side for its
// own users). Tight input validation + per-IP and global rate limits + response caching on top.
import crypto from 'node:crypto';

const sha256hex = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

// _kx values look like "<base64ish-identifier>.<company_id>". Accept a conservative charset; URL-decode
// first if the browser passed a still-encoded value (Klaviyo docs call this out).
export function normaliseKx(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  if (v.includes('%')) { try { v = decodeURIComponent(v); } catch { return null; } }
  return /^[A-Za-z0-9_.=+/-]{8,300}$/.test(v) ? v : null;
}

// __kla_id is either a bare anonymous UUID (unresolvable — no PII behind it) or base64 JSON carrying
// $exchange_id once the device has been identified. Extract the exchange id when present.
export function exchangeIdFromKlaId(raw) {
  const v = String(raw || '').trim();
  if (!v || v.length > 2048) return null;
  try {
    const decoded = Buffer.from(decodeURIComponent(v), 'base64').toString('utf8');
    const j = JSON.parse(decoded);
    return normaliseKx(j.$exchange_id || j.exchange_id || '');
  } catch { return null; }
}

// Klaviyo profile id (2026-08-31): a DURABLE identifier stamped on every email link as ?kl_pid=<id> via the
// account's UTM/custom link parameters (dynamic "profile_id"). Unlike _kx it never expires, so a subscriber
// who clicked an email weeks ago can still be resolved. Opaque id, no PII in the URL. Klaviyo ids are 26-char
// base32-ish strings; accept a conservative superset.
export function normalisePid(raw) {
  const v = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

// GA4 client_id validation: "123456789.987654321" — the browser sends the _ga cookie's last two segments.
// Shopify browser id (Web Pixel event.clientId / _shopify_y). REPRESENTATION RULE, 2026-09-15:
// canonical form inside Railway is the BARE uuid; the "shp." prefix exists only at the Meta boundary,
// where the browse leg sends external_id as "shp." + this value. Accept either form on input so a caller
// can pass whichever it holds, and always return bare - that keeps one row per browser in em_map instead
// of two, and stops the two representations being treated as different identities again.
export function normaliseScid(raw) {
  let v = String(raw || '').trim();
  if (v.slice(0, 4).toLowerCase() === 'shp.') v = v.slice(4);
  return /^[A-Za-z0-9-]{8,64}$/.test(v) ? v.toLowerCase() : null;
}

export function normaliseCid(raw) {
  const v = String(raw || '').trim();
  return /^[0-9]{5,15}\.[0-9]{5,15}$/.test(v) ? v : null;
}

export function createKxResolver(db, env = process.env) {
  const {
    KLAVIYO_JOY_API_KEY,
    KX_KLAVIYO_REVISION = '2026-07-15',
    KX_TIMEOUT_MS = 5000,
    KX_RATE_PER_IP_MIN = 6,          // per-IP requests/minute
    KX_RATE_GLOBAL_MIN = 30,         // global requests/minute (Klaviyo's own limit is 75/s — this is web-abuse guard)
    KX_NEG_TTL_HOURS = 6,            // re-try window for unresolved tokens
    KX_POS_TTL_DAYS = 90,            // cache horizon for resolved hashes (matches the cookie's 90d life)
    SCID_TTL_DAYS = 90,              // read-time horizon for Shopify-browser identity (matches joy_em_sha256)
  } = env;

  const active = !!KLAVIYO_JOY_API_KEY;
  if (!active) console.error('[kx] KLAVIYO_JOY_API_KEY missing — /kx-resolve disabled');

  // cache: kx token -> email hash (or NULL = known-unresolvable). Only the hash is ever at rest.
  db.exec(`CREATE TABLE IF NOT EXISTS kx_cache (kx TEXT PRIMARY KEY, em_hash TEXT, resolved_at INTEGER)`);
  // 2026-08-29: phone hash alongside email (Meta ph match key — digits-with-country-code, SHA-256).
  try { db.exec(`ALTER TABLE kx_cache ADD COLUMN ph_hash TEXT`); } catch {}

  // RECOGNITION MEMORY (2026-08-28): durable GA4 cid -> email hash. Banked at purchase (order webhook holds
  // both) and on successful kx resolutions that included a cid. Lets a returning browser whose joy_em_sha256
  // cookie expired — while _ga (~2y) persists — be re-recognised. 400d TTL, refreshed on every sighting.
  // Distinct from checkout_cid's 7d TTL: that maps ephemeral checkout tokens; this maps durable identity.
  db.exec(`CREATE TABLE IF NOT EXISTS em_map (cid TEXT PRIMARY KEY, em_hash TEXT, updated_at INTEGER)`);
  try { db.exec(`ALTER TABLE em_map ADD COLUMN ph_hash TEXT`); } catch {}
  // upsert preserves an existing ph_hash when the new sighting has none (e.g. order without a phone)
  const emPut   = db.prepare(`INSERT INTO em_map (cid, em_hash, ph_hash, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(cid) DO UPDATE SET em_hash = excluded.em_hash,
      ph_hash = COALESCE(excluded.ph_hash, em_map.ph_hash), updated_at = excluded.updated_at`);
  const emGet   = db.prepare('SELECT em_hash, ph_hash FROM em_map WHERE cid = ?');
  // 2026-09-15 (Shopify identity spine): em_map doubles as the scid store, keyed 'scid:<bare-uuid>' - the same
  // namespacing kx_cache already uses for 'pid:'. No new table, so the existing purge, backup and volume
  // semantics apply unchanged. updated_at is read back because scid rows carry their own shorter read-time TTL.
  const emGetFull = db.prepare('SELECT em_hash, ph_hash, updated_at FROM em_map WHERE cid = ?');
  const emDel     = db.prepare('DELETE FROM em_map WHERE cid = ?');
  const emPutRaw  = db.prepare('INSERT OR REPLACE INTO em_map (cid, em_hash, ph_hash, updated_at) VALUES (?, ?, ?, ?)');
  const emScidCount = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN ph_hash IS NOT NULL THEN 1 ELSE 0 END) ph FROM em_map WHERE cid LIKE 'scid:%'");
  const emPurge = db.prepare('DELETE FROM em_map WHERE updated_at < ?');
  const emCount = db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN ph_hash IS NOT NULL THEN 1 ELSE 0 END) ph FROM em_map');
  const cGet   = db.prepare('SELECT em_hash, ph_hash, resolved_at FROM kx_cache WHERE kx = ?');
  const cPut   = db.prepare('INSERT OR REPLACE INTO kx_cache (kx, em_hash, ph_hash, resolved_at) VALUES (?, ?, ?, ?)');
  const cPurge = db.prepare('DELETE FROM kx_cache WHERE resolved_at < ?');
  const cStats = db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN em_hash IS NOT NULL THEN 1 ELSE 0 END) resolved FROM kx_cache');

  // sliding-window rate limiter (in-memory; resets on restart, which is fine for an abuse guard)
  const ipHits = new Map();
  let globalHits = [];
  function rateLimited(ip) {
    const now = Date.now(), cut = now - 60000;
    globalHits = globalHits.filter((t) => t > cut);
    if (globalHits.length >= Number(KX_RATE_GLOBAL_MIN)) return true;
    const arr = (ipHits.get(ip) || []).filter((t) => t > cut);
    if (arr.length >= Number(KX_RATE_PER_IP_MIN)) { ipHits.set(ip, arr); return true; }
    arr.push(now); ipHits.set(ip, arr); globalHits.push(now);
    if (ipHits.size > 5000) ipHits.clear();            // memory backstop
    return false;
  }

  const counters = { hits: 0, cache_hits: 0, resolved: 0, unresolved: 0, rate_limited: 0, bad_input: 0, upstream_error: 0, cid_resolved: 0, cid_banked: 0, pid_hits: 0, pid_resolved: 0, scid_hits: 0, scid_resolved: 0, scid_banked: 0, scid_suppressed: 0, consent_denied: 0 };

  // bank a cid -> email-hash (+ optional phone-hash) pairing (purchase webhook + successful kx resolutions). Never throws.
  function captureCidEmail(cid, emHash, phHash) {
    try {
      const c = normaliseCid(cid);
      if (!c || !/^[a-f0-9]{64}$/.test(String(emHash || ''))) return;
      const ph = /^[a-f0-9]{64}$/.test(String(phHash || '')) ? phHash : null;
      emPut.run(c, emHash, ph, Date.now());
      emPurge.run(Date.now() - 400 * 86400000);
      counters.cid_banked++;
    } catch (e) { console.error('[kx] cid bank failed', e.message); }
  }

  // hash immediately; raw PII dies here. Phone: Klaviyo stores E.164 — Meta format = digits incl country code.
  function hashesFromAttrs(attrs) {
    if (!attrs?.email) return null;
    const phDigits = String(attrs.phone_number || '').replace(/[^0-9]/g, '');
    return { em: sha256hex(String(attrs.email).trim().toLowerCase()), ph: phDigits.length >= 8 ? sha256hex(phDigits) : null };
  }
  // Bank a Shopify browser id -> hashed identity. scid is a BROWSER key, not a person key, so the most
  // recently observed identity wins outright. That is why this cannot reuse emPut: emPut COALESCEs an old
  // ph_hash forward when the new sighting has none, which on a shared or resold browser would pair customer
  // B's email with customer A's phone. Here a CHANGED email replaces the phone too (even with null); only a
  // repeat sighting of the SAME email carries a previously known phone forward.
  // consentDenied = an explicit marketing/sale-of-data "false": bank nothing and suppress what is held.
  function captureScidIdentity(scid, emHash, phHash, consentDenied) {
    try {
      const bare = normaliseScid(scid);
      if (!bare) return false;
      const key = 'scid:' + bare;
      if (consentDenied) { emDel.run(key); counters.scid_suppressed++; return false; }
      const em = /^[a-f0-9]{64}$/.test(String(emHash || '')) ? String(emHash).toLowerCase() : null;
      const ph = /^[a-f0-9]{64}$/.test(String(phHash || '')) ? String(phHash).toLowerCase() : null;
      if (!em && !ph) return false;
      const prev = emGetFull.get(key);
      const nextEm = em || prev?.em_hash || null;
      let nextPh = ph;
      if (!nextPh) nextPh = (em && prev?.em_hash && prev.em_hash !== em) ? null : (prev?.ph_hash || null);
      if (!nextEm && !nextPh) return false;
      emPutRaw.run(key, nextEm, nextPh, Date.now());
      counters.scid_banked++;
      return true;
    } catch (e) { console.error('[kx] scid bank failed', e.message); return false; }
  }

  // Known scid -> stored hashes, or null. No fallback matching of any kind: unknown browser returns nothing.
  function lookupScid(scid) {
    try {
      const bare = normaliseScid(scid);
      if (!bare) return null;
      const row = emGetFull.get('scid:' + bare);
      if (!row || (!row.em_hash && !row.ph_hash)) return null;
      if (Date.now() - Number(row.updated_at || 0) > Number(SCID_TTL_DAYS) * 86400000) return null;
      return { em: row.em_hash || null, ph: row.ph_hash || null };
    } catch (e) { console.error('[kx] scid lookup failed', e.message); return null; }
  }

  const klHeaders = () => ({ Authorization: `Klaviyo-API-Key ${KLAVIYO_JOY_API_KEY}`, revision: KX_KLAVIYO_REVISION, accept: 'application/vnd.api+json' });

  // profile id -> hashes. 404 = unknown/deleted profile -> negative-cache. Never returns raw PII.
  async function profileLookup(pid) {
    const url = `https://a.klaviyo.com/api/profiles/${encodeURIComponent(pid)}/?fields[profile]=email,phone_number`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Number(KX_TIMEOUT_MS));
    try {
      const r = await fetch(url, { headers: klHeaders(), signal: ac.signal });
      if (r.status === 404 || r.status === 400) return null;
      if (!r.ok) throw new Error(`klaviyo ${r.status}`);
      const j = await r.json();
      return hashesFromAttrs(j?.data?.attributes);
    } finally { clearTimeout(t); }
  }

  async function klaviyoLookup(kx) {
    const filter = encodeURIComponent(`equals(_kx,'${kx}')`);
    const url = `https://a.klaviyo.com/api/profiles/?filter=${filter}&fields[profile]=email,phone_number`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Number(KX_TIMEOUT_MS));
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Klaviyo-API-Key ${KLAVIYO_JOY_API_KEY}`, revision: KX_KLAVIYO_REVISION, accept: 'application/vnd.api+json' },
        signal: ac.signal,
      });
      if (r.status === 400) return null;   // "Invalid _kx token" = expired/dead exchange id -> unresolvable, negative-cache it
      if (!r.ok) throw new Error(`klaviyo ${r.status}`);
      const j = await r.json();
      const attrs = j?.data?.[0]?.attributes || {};
      if (!attrs.email) return null;
      // hash immediately; raw PII dies here. Phone: Klaviyo stores E.164 — Meta format = digits incl country code.
      const phDigits = String(attrs.phone_number || '').replace(/[^0-9]/g, '');
      return {
        em: sha256hex(String(attrs.email).trim().toLowerCase()),
        ph: phDigits.length >= 8 ? sha256hex(phDigits) : null,
      };
    } finally { clearTimeout(t); }
  }

  // Express handler for POST /kx-resolve. Body: {kx?, kla_id?}. Responds {em: "<sha256hex>"} or {} — never PII.
  async function handle(req, res) {
    try {
      if (!active) return res.status(503).json({});
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      counters.hits++;
      if (rateLimited(ip)) { counters.rate_limited++; return res.status(429).json({}); }

      const cid = normaliseCid(req.body?.cid);
      const scid = normaliseScid(req.body?.scid);
      // CONSENT ON THE READ PATH, not only at write time (2026-09-15). A row banked yesterday while marketing
      // was allowed must not be handed back today after an explicit opt-out, merely because the database still
      // holds it. So an explicit decline short-circuits EVERY branch below - scid, cid recognition memory, _kx
      // and kl_pid alike - and additionally suppresses the stored scid row. Opt-out posture is unchanged:
      // only an explicit false blocks; unspecified stays allowed.
      const consentDenied = req.body?.consent === 'denied' || req.body?.marketing === false;
      if (consentDenied) {
        if (scid) captureScidIdentity(scid, null, null, true);
        counters.consent_denied++;
        return res.json({});
      }
      const kxTok = normaliseKx(req.body?.kx) || exchangeIdFromKlaId(req.body?.kla_id);
      const pid   = normalisePid(req.body?.kl_pid);
      // 2026-08-31: the durable profile id is preferred over the short-lived _kx exchange id when both arrive.
      // Cache key namespaced ('pid:') so it can never collide with a raw _kx value in kx_cache.
      const kx = pid ? 'pid:' + pid : kxTok;
      const lookup = pid ? () => profileLookup(pid) : () => klaviyoLookup(kxTok);
      if (pid) counters.pid_hits++;
      // response builder: only ever hashes, ph included when known
      const idJson = (em, ph) => (ph ? { em, ph } : { em });

      if (!kx) {
        // no Klaviyo token — recognition-memory path: known cid -> banked email (+phone) hash
        if (cid) {
          const hit = emGet.get(cid);
          if (hit?.em_hash) { counters.cid_resolved++; return res.json(idJson(hit.em_hash, hit.ph_hash)); }
        }
        // Shopify browser id: the deterministic key that survives when _ga and the Klaviyo token do not.
        if (scid) {
          counters.scid_hits++;
          const sHit = lookupScid(scid);
          if (sHit && (sHit.em || sHit.ph)) {
            counters.scid_resolved++;
            return res.json(sHit.em ? idJson(sHit.em, sHit.ph) : { ph: sHit.ph });
          }
        }
        if (cid || scid) { counters.unresolved++; return res.json({}); }
        counters.bad_input++; return res.status(400).json({});
      }

      const row = cGet.get(kx);
      if (row) {
        const age = Date.now() - row.resolved_at;
        if (row.em_hash && age < Number(KX_POS_TTL_DAYS) * 86400000) { counters.cache_hits++; if (cid) captureCidEmail(cid, row.em_hash, row.ph_hash); if (scid) captureScidIdentity(scid, row.em_hash, row.ph_hash, false); return res.json(idJson(row.em_hash, row.ph_hash)); }
        if (!row.em_hash && age < Number(KX_NEG_TTL_HOURS) * 3600000) { counters.cache_hits++; return res.json({}); }
      }

      let hit = null;
      try { hit = await lookup(); }
      catch (e) { counters.upstream_error++; console.error('[kx] lookup failed', e.message); return res.status(502).json({}); }

      cPut.run(kx, hit?.em || null, hit?.ph || null, Date.now());
      try { cPurge.run(Date.now() - Number(KX_POS_TTL_DAYS) * 86400000); } catch {}
      if (hit?.em) { counters.resolved++; if (pid) counters.pid_resolved++; if (cid) captureCidEmail(cid, hit.em, hit.ph); if (scid) captureScidIdentity(scid, hit.em, hit.ph, false); console.log('[kx] resolved -> hash', hit.em.slice(0, 12) + '…', hit.ph ? '+ph' : '', pid ? '(pid)' : ''); return res.json(idJson(hit.em, hit.ph)); }
      // kx token dead — recognition memory still gets a say before giving up
      if (cid) { const m = emGet.get(cid); if (m?.em_hash) { counters.cid_resolved++; return res.json(idJson(m.em_hash, m.ph_hash)); } }
      if (scid) { const sLate = lookupScid(scid); if (sLate?.em) { counters.scid_resolved++; return res.json(idJson(sLate.em, sLate.ph)); } }
      counters.unresolved++; return res.json({});
    } catch (e) {
      console.error('[kx] handler failed', e.message);
      return res.status(500).json({});
    }
  }

  function stats() {
    try { const c = cStats.get(); const m = emCount.get(); const sc = emScidCount.get(); return { active, ...counters, cache_rows: c.n, cache_resolved: c.resolved || 0, em_map_rows: m.n, em_map_ph_rows: m.ph || 0, scid_rows: sc.n, scid_ph_rows: sc.ph || 0 }; }
    catch (e) { return { active, error: e.message }; }
  }

  return { handle, stats, active, captureCidEmail, captureScidIdentity, lookupScid };
}
