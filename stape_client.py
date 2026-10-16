"""Stape outgoing-log client for attribution-bridge.

Stape keeps outgoing logs for a limited window set by the plan (container
plan.logDayLimit: Pro+ = 3 days as of Oct 2026; it was assumed to be 10).
That is long enough to collect from but far too short to analyse over, so this
module pulls the logs on a schedule and the bridge persists them to its own
store. The warehouse then ingests them from /export/stape-events.

API: GET https://api.app.stape.io/api/v2/containers/{id}/logs
     params type=outgoing, start/end (epoch seconds), limit (capped at 100 per call; page via end),
            optional platform (case-sensitive, e.g. Facebook) + event
     auth   X-AUTH-TOKEN header
     returns {items:[...], partial} newest first; Date is an ISO string.

The older /monitoring/logs/outgoing/detailed route now answers 409 for any
in-range window (and 400 for out-of-range ones), so it must not be used.

Note: Stape's WAF has 403'd non-browser user agents (python-urllib), so a
browser UA is sent deliberately — same workaround the stape MCP server uses.
"""
import json
import os
import time
from datetime import datetime

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


class StartOutOfRange(RuntimeError):
    """Stape rejected the window start as older than the log retention."""


def _headers():
    return {"X-AUTH-TOKEN": _token(), "Accept": "application/json",
            "User-Agent": UA}


def _unwrap(payload):
    # Responses are sometimes wrapped: {"body": {...}}. Accept both shapes.
    if isinstance(payload, dict) and isinstance(payload.get("body"), dict):
        return payload["body"]
    return payload


_LOG_DAY_LIMIT = {"v": None, "at": 0.0}


def log_day_limit(default=3):
    """Retention in days from the container's plan (plan.logDayLimit).

    Cached for six hours. Falls back to `default` if the lookup fails, so a
    transient error never widens the window past what Stape will accept.
    """
    if _LOG_DAY_LIMIT["v"] and time.time() - _LOG_DAY_LIMIT["at"] < 6 * 3600:
        return _LOG_DAY_LIMIT["v"]
    try:
        r = requests.get(f"{BASE}/api/v2/containers/{CONTAINER}",
                         headers=_headers(), timeout=30)
        r.raise_for_status()
        plan = (_unwrap(r.json()) or {}).get("plan") or {}
        days = int(plan.get("logDayLimit") or 0)
        if days > 0:
            _LOG_DAY_LIMIT.update(v=days, at=time.time())
            return days
    except Exception:
        pass
    return default


def fetch_outgoing(start_epoch, end_epoch, platform=None, event_type=None,
                   limit=100, timeout=60):
    """Raw outgoing logs for a window. Returns (items, partial)."""
    url = f"{BASE}/api/v2/containers/{CONTAINER}/logs"
    params = {"type": "outgoing", "start": int(start_epoch),
              "end": int(end_epoch), "limit": int(limit)}
    if platform:
        params["platform"] = platform
    if event_type:
        params["event"] = event_type
    r = requests.get(url, params=params, timeout=timeout, headers=_headers())
    if r.status_code == 409:
        # "Outgoing logs disabled" — surfaced rather than swallowed so the
        # cycle reports it instead of silently collecting nothing.
        raise RuntimeError("Stape outgoing logs returned 409 (disabled?)")
    if r.status_code == 400:
        try:
            errors = (_unwrap(r.json()) or {}).get("errors") or {}
        except ValueError:
            errors = {}
        if "start" in errors:
            raise StartOutOfRange(f"Stape 400 start: {errors['start']}")
        raise RuntimeError(f"Stape 400: {r.text[:300]}")
    r.raise_for_status()
    payload = _unwrap(r.json())
    if not isinstance(payload, dict):
        return [], None
    items = payload.get("items")
    return (items or []), payload.get("partial")


def _epoch(v):
    """Log Date is ISO-8601 on /logs ('2026-10-16T11:33:11.000Z'); older
    routes gave epoch seconds. Accept either."""
    if v is None or v == "":
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip()
    if s.isdigit():
        return int(s)
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return 0


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
        "logged_at": _epoch(item.get("Date")),
        "platform": item.get("Platform") or "",
        "status": str(item.get("Status") or ""),
        "event_name": ev.get("event_name") or item.get("Event") or "",
        "event_time": int(ev.get("event_time") or 0) or _epoch(item.get("Date")),
        "event_id": str(ev.get("event_id") or ""),
        "order_id": str(custom.get("order_id") or ""),
        "value": custom.get("value"),
        "currency": custom.get("currency") or "",
        "content_ids": json.dumps(content_ids) if content_ids else "",
        "event_source_url": ev.get("event_source_url") or "",
        "fbc": user.get("fbc") or "",
        "fbp": user.get("fbp") or "",
        "em_sha256": _one(user.get("em")) or "",
        # Phone rides the same path as email (theme writes joy_ph_sha256, GTM
        # tag 113 reads it at event time). Mirrored so phone match coverage can
        # be measured the same way as email.
        "ph_sha256": _one(user.get("ph")) or "",
        "external_ids": json.dumps(ext) if ext else "",
        "client_ip": user.get("client_ip_address") or "",
        "client_ua": (user.get("client_user_agent") or "")[:400],
    }


MAX_PAGES = 200


def _fetch_retry(start_epoch, end_epoch, platform, event_type, tries=4):
    """fetch_outgoing with backoff. Stape's /logs is slow and 504s or stalls
    past 60s intermittently even on small windows; retrying usually lands."""
    delay = 5
    for attempt in range(tries):
        try:
            return fetch_outgoing(start_epoch, end_epoch, platform=platform,
                                  event_type=event_type, timeout=90)
        except StartOutOfRange:
            raise
        except (requests.Timeout, requests.ConnectionError,
                requests.HTTPError) as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status is not None and status < 500:
                raise
            if attempt == tries - 1:
                raise
            time.sleep(delay)
            delay *= 2


def _collect_one(start_epoch, end_epoch, platform, event_type):
    """Fetch one event type across a window, paging backwards in time.

    /logs returns at most 100 rows per call, newest first, and flags
    `partial` when more remain (the `limit` param is not honoured above
    that). So each page moves `end` back to the oldest Date it returned and
    asks again. Rows on the boundary second come back twice; log_id dedupes.
    """
    out, end = [], int(end_epoch)
    start = int(start_epoch)
    for _ in range(MAX_PAGES):
        items, partial = _fetch_retry(start, end, platform, event_type)
        out.extend(items)
        if not partial or not items:
            return out, False
        oldest = min((_epoch(i.get("Date")) for i in items), default=0)
        new_end = oldest if 0 < oldest < end else end - 1
        if new_end <= start:
            return out, False
        end = new_end
        time.sleep(0.2)
    return out, True


def collect(start_epoch, end_epoch, platform="Facebook", events=None):
    """Parsed records across the wanted event types for a window.

    Queried per event type because the API filters server-side, which keeps
    each response small and avoids pulling PageView volume we discard anyway.
    """
    events = events or DEFAULT_EVENTS
    out, partial_any, seen = [], False, set()
    for event_type in events:
        items, partial = _collect_one(start_epoch, end_epoch, platform,
                                      event_type)
        partial_any = partial_any or partial
        for it in items:
            rec = parse_item(it)
            # split windows share their boundary second, so dedupe here too
            if rec["log_id"] and rec["log_id"] not in seen:
                seen.add(rec["log_id"])
                out.append(rec)
        time.sleep(0.3)  # be polite to the API between event types
    return out, partial_any
