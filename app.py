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
            "ENABLE_GOOGLE_ADJ", "ENABLE_META_AUDIENCES", "ENABLE_GOOGLE_CM")},
        "watermark": state.get("orders_watermark"),
        "last_cycle": state.get("last_cycle"),
        "last_cycle_counts": state.get("last_cycle_counts"),
        "last_audience_cycle": state.get("last_audience_cycle"),
        "last_audience_results": state.get("last_audience_results"),
        "ledger": state.stats(),
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


def _loop():
    last_audience_day = None
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
        time.sleep(CYCLE_MINUTES * 60)


state.init()
threading.Thread(target=_loop, daemon=True).start()
