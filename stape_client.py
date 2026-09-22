"""Stape outgoing-log client for attribution-bridge.

Stape keeps outgoing logs for a limited window (Business plan = 10 days; Pro = 3).
That is long enough to collect from but far too short to analyse over, so this
module pulls the logs on a schedule and the bridge persists them to its own
store. The warehouse then ingests them from /export/stape-events.

API: GET https://api.app.stape.io/api/v2/containers/{id}/monitoring/logs/outgoing/detailed
     params start/end (epoch seconds), optional platform + eventType
     auth   X-AUTH-TOKEN header

Note: Stape's WAF has 403'd non-browser user agents (python-urllib), so a
browser UA is sent deliberately — same workaround the stape MCP server uses.
"""
import json
import os
import time

import requests

BASE = os.environ.get("STAPE_API_BASE", "https://api.app.stape.io").rstrip("/")
CONTAINER = os.environ.get("STAPE_CONTAINER", "yrquagyh")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36 attribution-bridge/1.0")

# Funnel events worth keeping. PageView is deliberately excluded: ~3,300/day of
# it and it tells us nothing the order tables don't already.
DEFAULT_EVENTS = ("ViewContent", "AddToCart", "BeginCheckout",
                  "AddPaymentInfo", "Purchase")


def _token():
    return os.environ["STAPE_API_TOKEN"]


def fetch_outgoing(start_epoch, end_epoch, platform=None, event_type=None,
                   timeout=60):
    """Raw detailed outgoing logs for a window. Returns (items, partial)."""
    url = (f"{BASE}/api/v2/containers/{CONTAINER}"
           f"/monitoring/logs/outgoing/detailed")
    params = {"start": int(start_epoch), "end": int(end_epoch)}
    if platform:
        params["platform"] = platform
    if event_type:
        params["eventType"] = event_type
    r = requests.get(url, params=params, timeout=timeout,
                     headers={"X-AUTH-TOKEN": _token(),
                              "Accept": "application/json",
                              "User-Agent": UA})
    if r.status_code == 409:
        # "Outgoing logs disabled" — surfaced rather than swallowed so the
        # cycle reports it instead of silently collecting nothing.
        raise RuntimeError("Stape outgoing logs are disabled for this container")
    r.raise_for_status()
    payload = r.json()
    # The API wraps the result: {"body": {"items": [...], "partial": ...}}.
    # Older/other endpoints return items at the top level, so accept both.
    if isinstance(payload, dict) and isinstance(payload.get("body"), dict):
        payload = payload["body"]
    if not isinstance(payload, dict):
        return [], None
    items = payload.get("items")
    return (items or []), payload.get("partial")


def _first_event(request_body):
    """Stape posts {"data":[event], ...}; return the first event dict."""
    if not request_body:
        return {}
    try:
        parsed = json.loads(request_body)
    except (ValueError, TypeError):
        return {}
    data = parsed.get("data") if isinstance(parsed, dict) else None
    if isinstance(data, list) and data:
        return data[0] if isinstance(data[0], dict) else {}
    return {}


def parse_item(item):
    """Flatten one log row into a warehouse-shaped record.

    Only hashed identifiers are kept (Stape hashes em/ph/fn/ln before send),
    plus fbc/fbp/gclid which are click and browser ids, not personal data.
    Raw names, emails and phone numbers are never stored.
    """
    ev = _first_event(item.get("Request-Body"))
    custom = ev.get("custom_data") or {}
    user = ev.get("user_data") or {}

    contents = custom.get("contents")
    content_ids = []
    if isinstance(contents, list):
        for c in contents:
            if isinstance(c, dict) and c.get("id") is not None:
                content_ids.append(str(c["id"]))

    ext = user.get("external_id")
    if isinstance(ext, str):
        ext = [ext]
    elif not isinstance(ext, list):
        ext = []

    def _one(v):
        """user_data values are sometimes scalars, sometimes single-item lists."""
        if isinstance(v, list):
            return v[0] if v else None
        return v

    return {
        "log_id": str(item.get("Id") or ""),
        "logged_at": int(item.get("Date") or 0),
        "platform": item.get("Platform") or "",
        "status": str(item.get("Status") or ""),
        "event_name": ev.get("event_name") or item.get("Event") or "",
        "event_time": int(ev.get("event_time") or item.get("Date") or 0),
        "event_id": str(ev.get("event_id") or ""),
        "order_id": str(custom.get("order_id") or ""),
        "value": custom.get("value"),
        "currency": custom.get("currency") or "",
        "content_ids": json.dumps(content_ids) if content_ids else "",
        "event_source_url": ev.get("event_source_url") or "",
        "fbc": user.get("fbc") or "",
        "fbp": user.get("fbp") or "",
        "em_sha256": _one(user.get("em")) or "",
        "external_ids": json.dumps(ext) if ext else "",
        "client_ip": user.get("client_ip_address") or "",
        "client_ua": (user.get("client_user_agent") or "")[:400],
    }


MIN_SPLIT_SECONDS = 900  # don't subdivide below 15 minutes


def _collect_one(start_epoch, end_epoch, platform, event_type, depth=0):
    """Fetch one event type, halving the window if the API truncates.

    The endpoint caps a response at 1000 rows and flags `partial`. A busy
    event (ViewContent runs ~250/day) will hit that on a multi-day backfill,
    so the window is split until each half comes back complete.
    """
    items, partial = fetch_outgoing(start_epoch, end_epoch,
                                    platform=platform, event_type=event_type)
    span = end_epoch - start_epoch
    if not partial or span <= MIN_SPLIT_SECONDS or depth >= 8:
        return items, bool(partial)
    mid = start_epoch + span / 2
    time.sleep(0.2)
    left, lp = _collect_one(start_epoch, mid, platform, event_type, depth + 1)
    time.sleep(0.2)
    right, rp = _collect_one(mid, end_epoch, platform, event_type, depth + 1)
    return left + right, (lp or rp)


def collect(start_epoch, end_epoch, platform="Facebook", events=None):
    """Parsed records across the wanted event types for a window.

    Queried per event type because the API filters server-side, which keeps
    each response small and avoids pulling PageView volume we discard anyway.
    """
    events = events or DEFAULT_EVENTS
    out, partial_any, seen = [], False, set()
    for event_type in events:
        items, partial = _collect_one(start_epoch, end_epoch, platform, event_type)
        partial_any = partial_any or partial
        for it in items:
            rec = parse_item(it)
            # split windows share their boundary second, so dedupe here too
            if rec["log_id"] and rec["log_id"] not in seen:
                seen.add(rec["log_id"])
                out.append(rec)
        time.sleep(0.3)  # be polite to the API between event types
    return out, partial_any
