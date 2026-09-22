"""attribution-bridge HTTP surface + scheduler loop."""
import os
import threading
import time
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException

import bridge
import state

app = FastAPI(title="attribution-bridge")
CYCLE_MINUTES = int(os.environ.get("CYCLE_MINUTES", "15"))
AUDIENCE_HOUR_UTC = int(os.environ.get("AUDIENCE_HOUR_UTC", "3"))
# Stape keeps 10 days, so 3-hourly leaves a very large safety margin.
LOG_CYCLE_MINUTES = int(os.environ.get("LOG_CYCLE_MINUTES", "180"))
GCLID_CYCLE_MINUTES = int(os.environ.get("GCLID_CYCLE_MINUTES", "360"))


def _check_key(x_api_key):
    expected = os.environ.get("BRIDGE_API_KEY", "")
    if not expected or x_api_key != expected:
        raise HTTPException(status_code=401, detail="bad api key")


@app.get("/health")
def health():
    return {"ok": True, "dry_run": bridge.dry_run(),
            "last_cycle": state.get("last_cycle"),
            "last_audience_cycle": state.get("last_audience_cycle")}


@app.get("/status")
def status():
    return {
        "dry_run": bridge.dry_run(),
        "flags": {k: bridge.flag(k) for k in (
            "ENABLE_META_PURCHASE", "ENABLE_PROFIT_EVENT",
            "ENABLE_GOOGLE_ADJ", "ENABLE_META_AUDIENCES", "ENABLE_GOOGLE_CM",
            "ENABLE_STAPE_LOGS", "ENABLE_GCLID_RESOLVE")},
        "watermark": state.get("orders_watermark"),
        "last_cycle": state.get("last_cycle"),
        "last_cycle_counts": state.get("last_cycle_counts"),
        "last_audience_cycle": state.get("last_audience_cycle"),
        "last_audience_results": state.get("last_audience_results"),
        "last_log_cycle": state.get("last_log_cycle"),
        "last_log_cycle_counts": state.get("last_log_cycle_counts"),
        "last_gclid_cycle": state.get("last_gclid_cycle"),
        "last_gclid_counts": state.get("last_gclid_counts"),
        "ledger": state.stats(),
        "stape_events": state.stape_stats(),
        "gclids": state.gclid_stats(),
        "log_tail": bridge.LOG_RING[-40:],
    }


@app.post("/run-cycle")
def run_cycle(x_api_key: str = Header(default="")):
    _check_key(x_api_key)
    return bridge.order_cycle()


@app.post("/run-audiences")
def run_audiences(x_api_key: str = Header(default="")):
    _check_key(x_api_key)
    # the full pull (newsletter + purchasers) outlasts the edge HTTP timeout,
    # so run it in the background and report progress via /status
    threading.Thread(target=bridge.audience_cycle, daemon=True).start()
    return {"started": True, "note": "running in background; poll /status"}


@app.post("/run-log-cycle")
def run_log_cycle(backfill_days: int = 0, x_api_key: str = Header(default="")):
    """Pull Stape outgoing logs into local state. backfill_days widens the
    window on demand, capped at Stape's retention limit."""
    _check_key(x_api_key)
    return bridge.log_cycle(backfill_days=backfill_days or None)


@app.post("/run-gclid-cycle")
def run_gclid_cycle(x_api_key: str = Header(default="")):
    _check_key(x_api_key)
    return bridge.gclid_cycle()


@app.get("/export/stape-events")
def export_stape_events(after_seq: int = 0, limit: int = 5000,
                        x_api_key: str = Header(default="")):
    """Incremental pull for the warehouse. Page with the returned max_seq."""
    _check_key(x_api_key)
    rows = state.stape_export(after_seq=after_seq, limit=min(limit, 20000))
    return {"rows": rows, "count": len(rows),
            "max_seq": rows[-1]["seq"] if rows else after_seq,
            "has_more": len(rows) == min(limit, 20000)}


@app.get("/export/gclid-campaigns")
def export_gclid_campaigns(after_seq: int = 0, limit: int = 5000,
                           x_api_key: str = Header(default="")):
    _check_key(x_api_key)
    rows = state.gclid_export(after_seq=after_seq, limit=min(limit, 20000))
    return {"rows": rows, "count": len(rows),
            "max_seq": rows[-1]["seq"] if rows else after_seq,
            "has_more": len(rows) == min(limit, 20000)}


def _loop():
    last_audience_day = None
    last_log = 0.0
    last_gclid = 0.0
    while True:
        try:
            bridge.order_cycle()
        except Exception as e:
            bridge.log(f"LOOP cycle error: {e}")
        now = datetime.now(timezone.utc)
        if now.hour >= AUDIENCE_HOUR_UTC and last_audience_day != now.date():
            try:
                bridge.audience_cycle()
                last_audience_day = now.date()
            except Exception as e:
                bridge.log(f"LOOP audience error: {e}")
        if time.time() - last_log >= LOG_CYCLE_MINUTES * 60:
            try:
                bridge.log_cycle()
            except Exception as e:
                bridge.log(f"LOOP log cycle error: {e}")
            last_log = time.time()
        if time.time() - last_gclid >= GCLID_CYCLE_MINUTES * 60:
            try:
                bridge.gclid_cycle()
            except Exception as e:
                bridge.log(f"LOOP gclid cycle error: {e}")
            last_gclid = time.time()
        time.sleep(CYCLE_MINUTES * 60)


state.init()
threading.Thread(target=_loop, daemon=True).start()
