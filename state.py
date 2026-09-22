"""SQLite state for attribution-bridge: watermarks + sent-event ledger."""
import os
import sqlite3
import threading
import time

DB_PATH = os.environ.get("STATE_DB", "/data/attribution_bridge.db")
_lock = threading.Lock()


def _conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init():
    with _lock, _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS kv (
            k TEXT PRIMARY KEY, v TEXT, updated_at REAL)""")
        c.execute("""CREATE TABLE IF NOT EXISTS sent_events (
            event_key TEXT PRIMARY KEY,   -- e.g. meta_purchase:6391822... / gads_adj:refund_123
            sent_at REAL,
            dry_run INTEGER,
            detail TEXT)""")
        c.execute("""CREATE TABLE IF NOT EXISTS audience_members (
            audience TEXT, em_sha256 TEXT, added_at REAL,
            PRIMARY KEY (audience, em_sha256))""")
        # Stape outgoing-log mirror. seq is the incremental cursor the warehouse
        # pulls against; log_id is Stape's own row id and carries the dedupe.
        c.execute("""CREATE TABLE IF NOT EXISTS stape_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            log_id TEXT UNIQUE,
            logged_at INTEGER, event_time INTEGER,
            platform TEXT, status TEXT, event_name TEXT, event_id TEXT,
            order_id TEXT, value REAL, currency TEXT,
            content_ids TEXT, event_source_url TEXT,
            fbc TEXT, fbp TEXT, em_sha256 TEXT, ph_sha256 TEXT,
            external_ids TEXT,
            client_ip TEXT, client_ua TEXT,
            inserted_at REAL)""")
        # Added after the table shipped, so existing deployments need the column
        # bolted on. SQLite has no IF NOT EXISTS for ADD COLUMN.
        cols = {r[1] for r in c.execute("PRAGMA table_info(stape_events)")}
        if "ph_sha256" not in cols:
            c.execute("ALTER TABLE stape_events ADD COLUMN ph_sha256 TEXT")
        c.execute("CREATE INDEX IF NOT EXISTS ix_stape_ev_time "
                  "ON stape_events (event_time)")
        c.execute("CREATE INDEX IF NOT EXISTS ix_stape_ev_name "
                  "ON stape_events (event_name)")
        c.execute("CREATE INDEX IF NOT EXISTS ix_stape_ev_em "
                  "ON stape_events (em_sha256)")
        # gclid -> campaign, resolved from the Google Ads click_view report.
        c.execute("""CREATE TABLE IF NOT EXISTS gclid_campaigns (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            gclid TEXT UNIQUE,
            order_id TEXT, order_date TEXT,
            campaign_id TEXT, campaign_name TEXT,
            ad_group_id TEXT, ad_group_name TEXT,
            click_date TEXT, resolved INTEGER DEFAULT 0,
            attempts INTEGER DEFAULT 0,
            first_seen REAL, resolved_at REAL)""")
        c.execute("CREATE INDEX IF NOT EXISTS ix_gclid_resolved "
                  "ON gclid_campaigns (resolved, attempts)")


def get(k, default=None):
    with _lock, _conn() as c:
        row = c.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
    return row[0] if row else default


def set_(k, v):
    with _lock, _conn() as c:
        c.execute("INSERT INTO kv (k, v, updated_at) VALUES (?,?,?) "
                  "ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at",
                  (k, str(v), time.time()))


def already_sent(event_key):
    with _lock, _conn() as c:
        row = c.execute("SELECT dry_run FROM sent_events WHERE event_key=?", (event_key,)).fetchone()
    # a dry-run record does not block a later live send
    return row is not None and row[0] == 0


def mark_sent(event_key, dry_run, detail=""):
    with _lock, _conn() as c:
        c.execute("INSERT INTO sent_events (event_key, sent_at, dry_run, detail) VALUES (?,?,?,?) "
                  "ON CONFLICT(event_key) DO UPDATE SET sent_at=excluded.sent_at, "
                  "dry_run=excluded.dry_run, detail=excluded.detail",
                  (event_key, time.time(), 1 if dry_run else 0, detail[:500]))


def audience_new_members(audience, hashes):
    """Return the subset of hashes not yet recorded for this audience."""
    new = []
    with _lock, _conn() as c:
        for h in hashes:
            row = c.execute("SELECT 1 FROM audience_members WHERE audience=? AND em_sha256=?",
                            (audience, h)).fetchone()
            if not row:
                new.append(h)
    return new


def audience_record_members(audience, hashes):
    now = time.time()
    with _lock, _conn() as c:
        c.executemany("INSERT OR IGNORE INTO audience_members (audience, em_sha256, added_at) "
                      "VALUES (?,?,?)", [(audience, h, now) for h in hashes])


def stats():
    with _lock, _conn() as c:
        sent = c.execute("SELECT COUNT(*) FROM sent_events WHERE dry_run=0").fetchone()[0]
        dry = c.execute("SELECT COUNT(*) FROM sent_events WHERE dry_run=1").fetchone()[0]
        aud = c.execute("SELECT audience, COUNT(*) FROM audience_members GROUP BY audience").fetchall()
    return {"sent_live": sent, "sent_dry": dry, "audiences": dict(aud)}


# ── Stape event mirror ───────────────────────────────────────────────────────

_STAPE_COLS = ("log_id", "logged_at", "event_time", "platform", "status",
               "event_name", "event_id", "order_id", "value", "currency",
               "content_ids", "event_source_url", "fbc", "fbp", "em_sha256",
               "ph_sha256", "external_ids", "client_ip", "client_ua")


def stape_insert(records):
    """INSERT OR IGNORE on log_id. Returns the number of genuinely new rows."""
    if not records:
        return 0
    now = time.time()
    rows = [tuple(r.get(col) for col in _STAPE_COLS) + (now,) for r in records]
    placeholders = ",".join("?" * (len(_STAPE_COLS) + 1))
    with _lock, _conn() as c:
        before = c.execute("SELECT COUNT(*) FROM stape_events").fetchone()[0]
        c.executemany(
            f"INSERT OR IGNORE INTO stape_events "
            f"({','.join(_STAPE_COLS)}, inserted_at) VALUES ({placeholders})",
            rows)
        after = c.execute("SELECT COUNT(*) FROM stape_events").fetchone()[0]
    return after - before


def stape_export(after_seq=0, limit=5000):
    """Rows above a cursor, oldest first — the warehouse's incremental pull."""
    cols = ("seq",) + _STAPE_COLS
    with _lock, _conn() as c:
        rows = c.execute(
            f"SELECT {','.join(cols)} FROM stape_events "
            f"WHERE seq > ? ORDER BY seq LIMIT ?",
            (int(after_seq), int(limit))).fetchall()
    return [dict(zip(cols, r)) for r in rows]


def stape_stats():
    with _lock, _conn() as c:
        total = c.execute("SELECT COUNT(*) FROM stape_events").fetchone()[0]
        max_seq = c.execute("SELECT COALESCE(MAX(seq),0) FROM stape_events").fetchone()[0]
        by_event = c.execute(
            "SELECT event_name, COUNT(*) FROM stape_events "
            "GROUP BY event_name ORDER BY 2 DESC").fetchall()
        span = c.execute("SELECT MIN(event_time), MAX(event_time) "
                         "FROM stape_events").fetchone()
    return {"rows": total, "max_seq": max_seq, "by_event": dict(by_event),
            "event_time_min": span[0], "event_time_max": span[1]}


# ── gclid → campaign ─────────────────────────────────────────────────────────

def gclid_add_pending(gclid, order_id, order_date):
    """Record a gclid awaiting resolution. No-op if already known."""
    if not gclid:
        return
    with _lock, _conn() as c:
        c.execute("INSERT OR IGNORE INTO gclid_campaigns "
                  "(gclid, order_id, order_date, first_seen) VALUES (?,?,?,?)",
                  (gclid, str(order_id), order_date, time.time()))


def gclid_pending(max_attempts=4, limit=200):
    """Unresolved gclids that have not exhausted their retries."""
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT gclid, order_id, order_date FROM gclid_campaigns "
            "WHERE resolved=0 AND attempts < ? ORDER BY first_seen LIMIT ?",
            (int(max_attempts), int(limit))).fetchall()
    return [{"gclid": r[0], "order_id": r[1], "order_date": r[2]} for r in rows]


def gclid_resolve(gclid, campaign_id, campaign_name, ad_group_id=None,
                  ad_group_name=None, click_date=None):
    with _lock, _conn() as c:
        c.execute("UPDATE gclid_campaigns SET campaign_id=?, campaign_name=?, "
                  "ad_group_id=?, ad_group_name=?, click_date=?, resolved=1, "
                  "resolved_at=? WHERE gclid=?",
                  (str(campaign_id), campaign_name, ad_group_id, ad_group_name,
                   click_date, time.time(), gclid))


def gclid_bump_attempts(gclids):
    if not gclids:
        return
    with _lock, _conn() as c:
        c.executemany("UPDATE gclid_campaigns SET attempts = attempts + 1 "
                      "WHERE gclid=?", [(g,) for g in gclids])


def gclid_export(after_seq=0, limit=5000):
    cols = ("seq", "gclid", "order_id", "order_date", "campaign_id",
            "campaign_name", "ad_group_id", "ad_group_name", "click_date",
            "resolved")
    with _lock, _conn() as c:
        rows = c.execute(
            f"SELECT {','.join(cols)} FROM gclid_campaigns "
            f"WHERE seq > ? AND resolved=1 ORDER BY seq LIMIT ?",
            (int(after_seq), int(limit))).fetchall()
    return [dict(zip(cols, r)) for r in rows]


def gclid_stats():
    with _lock, _conn() as c:
        total = c.execute("SELECT COUNT(*) FROM gclid_campaigns").fetchone()[0]
        done = c.execute("SELECT COUNT(*) FROM gclid_campaigns "
                         "WHERE resolved=1").fetchone()[0]
        max_seq = c.execute("SELECT COALESCE(MAX(seq),0) FROM gclid_campaigns "
                            "WHERE resolved=1").fetchone()[0]
    return {"gclids": total, "resolved": done, "pending": total - done,
            "max_seq": max_seq}
