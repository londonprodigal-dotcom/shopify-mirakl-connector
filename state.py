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
