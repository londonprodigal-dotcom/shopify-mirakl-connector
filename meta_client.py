"""Meta CAPI + custom audience client for attribution-bridge (JOY)."""
import json
import os
import time

import requests

GRAPH = "https://graph.facebook.com/v21.0"
PIXEL_ID = os.environ.get("META_PIXEL_JOY_ID", "314583795666143")
SITE_URL = "https://www.joythestore.com"


def _capi_token():
    return os.environ["META_CAPI_JOY_TOKEN"]


def _ads_token():
    return os.environ["META_ACCESS_TOKEN"]


def _account_id():
    acct = os.environ["META_JOY_ACCOUNT_ID"]
    return acct if acct.startswith("act_") else f"act_{acct}"


def build_user_data(order, sha):
    """Hashed user_data dict from a Shopify order's customer block."""
    cust = order.get("customer") or {}
    addr = cust.get("defaultAddress") or {}
    ud = {}
    pairs = [
        ("em", cust.get("email")),
        ("ph", (cust.get("phone") or "").replace("+", "").replace(" ", "").replace("-", "")),
        ("fn", cust.get("firstName")),
        ("ln", cust.get("lastName")),
        ("ct", addr.get("city")),
        ("st", addr.get("provinceCode")),
        ("zp", addr.get("zip")),
        ("country", addr.get("countryCodeV2")),
    ]
    for key, raw in pairs:
        h = sha(raw)
        if h:
            ud[key] = [h]
    return ud


def send_events(events, test_event_code=None):
    payload = {"data": json.dumps(events), "access_token": _capi_token()}
    if test_event_code:
        payload["test_event_code"] = test_event_code
    r = requests.post(f"{GRAPH}/{PIXEL_ID}/events", data=payload, timeout=30)
    body = r.json()
    if r.status_code != 200:
        raise RuntimeError(f"CAPI error {r.status_code}: {json.dumps(body)[:400]}")
    return body


def purchase_event(order, user_data, value, currency, event_name="Purchase",
                   event_id=None):
    created = order["createdAt"]
    event_time = int(time.mktime(time.strptime(created[:19], "%Y-%m-%dT%H:%M:%S")))
    # CAPI rejects events older than 7 days
    event_time = max(event_time, int(time.time()) - 6 * 86400)
    return {
        "event_name": event_name,
        "event_time": event_time,
        # Bare order id, matching what Stape's server-side Purchase already sends
        # (verified: event_id == order_id on 30 of 30 live events). Meta dedupes
        # on event_id, so the old "shopify_order_<id>" form would NOT have matched
        # and every purchase would have been counted twice if this were switched
        # on. A guard only — ENABLE_META_PURCHASE stays off, because Stape fires
        # at checkout with fbc/fbp attached and this fires later with neither.
        "event_id": event_id or str(order["legacyResourceId"]),
        "action_source": "website",
        "event_source_url": SITE_URL,
        "user_data": user_data,
        "custom_data": {
            "currency": currency,
            "value": value,
            "order_id": str(order["legacyResourceId"]),
        },
    }


# ── Custom audiences ─────────────────────────────────────────────────────────

def ensure_audience(name, description, state_get, state_set):
    """Create the audience once; cache its id in bridge state."""
    key = f"meta_audience_id:{name}"
    aid = state_get(key)
    if aid:
        return aid
    r = requests.post(
        f"{GRAPH}/{_account_id()}/customaudiences",
        data={
            "name": name,
            "description": description,
            "subtype": "CUSTOM",
            "customer_file_source": "USER_PROVIDED_ONLY",
            "access_token": _ads_token(),
        },
        timeout=30,
    )
    body = r.json()
    if r.status_code != 200:
        raise RuntimeError(f"audience create failed: {json.dumps(body)[:400]}")
    state_set(key, body["id"])
    return body["id"]


def add_audience_users(audience_id, em_hashes, batch=5000):
    """Append EMAIL_SHA256 members. Returns count of users uploaded."""
    sent = 0
    for i in range(0, len(em_hashes), batch):
        chunk = em_hashes[i:i + batch]
        payload = {"schema": "EMAIL_SHA256", "data": [[h] for h in chunk]}
        r = requests.post(
            f"{GRAPH}/{audience_id}/users",
            data={"payload": json.dumps(payload), "access_token": _ads_token()},
            timeout=60,
        )
        body = r.json()
        if r.status_code != 200:
            raise RuntimeError(f"audience users failed: {json.dumps(body)[:400]}")
        sent += body.get("num_received", len(chunk))
    return sent
