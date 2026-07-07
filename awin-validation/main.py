#!/usr/bin/env python3
"""
Awin validation service — web wrapper + internal daily scheduler.

Endpoints:
  GET  /health  — liveness + last run summary (counts only)
  POST /run     — trigger a validation run now (X-API-Key required).
                  Query param ?dry_run=true/false overrides the DRY_RUN env
                  default for this run only.

Scheduling: an internal thread fires the job daily at RUN_AT_UTC (default
05:00 UTC). No separate cron service — Railway cron is best-effort and this
job is cheap enough to keep a scheduler thread alive.
"""

import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, request

import validation

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("awin-validation.web")

app = Flask(__name__)

RUN_AT_UTC = os.environ.get("RUN_AT_UTC", "05:00")
DEFAULT_DRY_RUN = os.environ.get("DRY_RUN", "true").lower() != "false"

_state = {"last_run": None, "running": False}
_lock = threading.Lock()


def _do_run(dry_run):
    with _lock:
        if _state["running"]:
            return {"error": "run already in progress"}
        _state["running"] = True
    try:
        summary = validation.run(dry_run=dry_run)
        _state["last_run"] = summary
        return summary
    except Exception as e:
        log.exception("validation run failed")
        _state["last_run"] = {
            "started_at": datetime.now(timezone.utc).isoformat(),
            "dry_run": dry_run,
            "error": str(e),
        }
        return _state["last_run"]
    finally:
        _state["running"] = False


def _scheduler():
    hh, mm = (int(x) for x in RUN_AT_UTC.split(":"))
    while True:
        now = datetime.now(timezone.utc)
        nxt = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if nxt <= now:
            nxt += timedelta(days=1)
        wait = (nxt - now).total_seconds()
        log.info("scheduler: next run at %s (%.0fs)", nxt.isoformat(), wait)
        time.sleep(wait)
        log.info("scheduler: starting daily run (dry_run=%s)", DEFAULT_DRY_RUN)
        _do_run(DEFAULT_DRY_RUN)


@app.get("/health")
def health():
    last = _state["last_run"]
    brief = None
    if last:
        brief = {k: last.get(k) for k in ("started_at", "finished_at", "dry_run", "error")}
        if "brands" in last:
            brief["brands"] = {
                b: {k: v for k, v in d.items() if k != "decisions"}
                for b, d in last["brands"].items()
            }
    return jsonify({"ok": True, "running": _state["running"],
                    "default_dry_run": DEFAULT_DRY_RUN, "last_run": brief})


@app.post("/run")
def run_now():
    key = os.environ.get("VALIDATION_API_KEY", "")
    if not key or request.headers.get("X-API-Key") != key:
        return jsonify({"error": "unauthorized"}), 401
    arg = request.args.get("dry_run")
    dry_run = DEFAULT_DRY_RUN if arg is None else (arg.lower() != "false")
    summary = _do_run(dry_run)
    return jsonify(summary)


threading.Thread(target=_scheduler, daemon=True).start()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
