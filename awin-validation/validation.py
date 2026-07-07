#!/usr/bin/env python3
"""
Awin transaction validation — core logic.

Daily job:
  1. Pull pending Awin transactions for both brands (last LOOKBACK_DAYS days).
  2. Fetch each transaction's Shopify order (by orderRef = Shopify order ID).
  3. Decide:
       - order cancelled            -> decline "Cancelled in Shopify"
       - fully refunded             -> decline "Returned in Shopify"
       - partially refunded AND
         txn age >= MIN_AMEND_AGE   -> amend saleAmount down proportionally
         (single amend only — Awin rejects re-amendment of amended sales)
       - otherwise                  -> leave pending (Awin auto-approves ~30d)
  4. POST decisions to Awin batch validation endpoint (unless DRY_RUN).

Design notes:
  - Awin tracks sale amounts ex-VAT; Shopify amounts are inc-VAT. We never
    convert absolute values — amendments scale the Awin-tracked amount by
    the kept fraction of the Shopify product subtotal (ex-shipping), so the
    VAT basis cancels out.
  - Partial amendments wait until MIN_AMEND_AGE_DAYS so late follow-up
    returns on the same order are captured in the single allowed amendment.
"""

import logging
import os
import time
from datetime import datetime, timedelta, timezone

import requests

log = logging.getLogger("awin-validation")

AWIN_BASE = "https://api.awin.com"
SHOPIFY_API_VERSION = "2025-01"

LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "75"))
MIN_AMEND_AGE_DAYS = int(os.environ.get("MIN_AMEND_AGE_DAYS", "25"))
CHUNK_DAYS = 31

DECLINE_REASON_RETURNED = "Returned in Shopify"
DECLINE_REASON_CANCELLED = "Cancelled in Shopify"
AMEND_REASON = "Partial return in Shopify"


def _env(name):
    v = os.environ.get(name, "").strip()
    if not v:
        raise RuntimeError(f"Missing required env var: {name}")
    return v


def brands():
    return {
        "joy": {"advertiser_id": _env("AWIN_JOY_ADVERTISER_ID")},
        "louche": {"advertiser_id": _env("AWIN_LOUCHE_ADVERTISER_ID")},
    }


# ── Awin API ─────────────────────────────────────────────────────────────────

def _awin_headers():
    return {"Authorization": f"Bearer {_env('AWIN_API_TOKEN')}", "Accept": "application/json"}


def _awin_get(path, params):
    for attempt in range(4):
        resp = requests.get(f"{AWIN_BASE}{path}", params=params, headers=_awin_headers(), timeout=30)
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 2 ** (attempt + 1)))
            log.warning("Awin 429, backing off %ss", wait)
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError(f"Awin rate limit exceeded at {path}")


def get_pending_transactions(advertiser_id):
    """Pending transactions over the lookback window, chunked to 31 days."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=LOOKBACK_DAYS)
    out = []
    chunk_start = start
    while chunk_start < end:
        chunk_end = min(chunk_start + timedelta(days=CHUNK_DAYS - 1), end)
        data = _awin_get(
            f"/advertisers/{advertiser_id}/transactions/",
            {
                "startDate": chunk_start.strftime("%Y-%m-%dT00:00:00"),
                "endDate": chunk_end.strftime("%Y-%m-%dT23:59:59"),
                "timezone": "UTC",
            },
        )
        out.extend(t for t in data if t.get("commissionStatus") == "pending")
        chunk_start = chunk_end + timedelta(seconds=1)
    return out


def post_validations(advertiser_id, actions):
    """POST an array of validation actions to the Awin batch endpoint."""
    resp = requests.post(
        f"{AWIN_BASE}/advertisers/{advertiser_id}/transactions/batch",
        json=actions,
        headers={**_awin_headers(), "Content-Type": "application/json"},
        timeout=60,
    )
    body = resp.text[:2000]
    if resp.status_code not in (200, 207):
        raise RuntimeError(f"Awin batch validation failed: HTTP {resp.status_code}: {body}")
    return {"status": resp.status_code, "body": body}


# ── Shopify API ──────────────────────────────────────────────────────────────

_token_cache = {}


def _shopify_token(brand):
    if brand in _token_cache:
        return _token_cache[brand]
    domain = _env(f"SHOPIFY_{brand.upper()}_DOMAIN")
    resp = requests.post(
        f"https://{domain}/admin/oauth/access_token",
        json={
            "client_id": _env(f"SHOPIFY_{brand.upper()}_CLIENT_ID"),
            "client_secret": _env(f"SHOPIFY_{brand.upper()}_CLIENT_SECRET"),
            "grant_type": "client_credentials",
        },
        timeout=30,
    )
    resp.raise_for_status()
    _token_cache[brand] = resp.json()["access_token"]
    return _token_cache[brand]


def clear_token_cache():
    _token_cache.clear()


def get_order(brand, order_id):
    """Fetch one Shopify order. Returns None if not found."""
    domain = _env(f"SHOPIFY_{brand.upper()}_DOMAIN")
    fields = "id,name,cancelled_at,financial_status,subtotal_price,current_subtotal_price"
    resp = requests.get(
        f"https://{domain}/admin/api/{SHOPIFY_API_VERSION}/orders/{order_id}.json",
        params={"fields": fields},
        headers={"X-Shopify-Access-Token": _shopify_token(brand)},
        timeout=30,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json().get("order")


# ── Decision logic ───────────────────────────────────────────────────────────

def _scaled_parts(parts, fraction, new_sale):
    """Scale transactionParts by fraction; last part absorbs rounding so the
    sum exactly equals new_sale (Awin requires parts sum == saleAmount)."""
    scaled = [round(p["amount"] * fraction, 2) for p in parts]
    drift = round(new_sale - sum(scaled), 2)
    scaled[-1] = round(scaled[-1] + drift, 2)
    return [
        {"amount": amt, "commissionGroupCode": p["commissionGroupCode"]}
        for p, amt in zip(parts, scaled)
    ]


def decide(txn, order, now=None):
    """Return (decision_dict | None, log_reason). decision_dict is an Awin
    batch action object; None means leave the transaction pending."""
    now = now or datetime.now(timezone.utc)
    txn_id = txn["id"]

    if order is None:
        return None, "order not found in Shopify — skipped for manual review"

    if order.get("cancelled_at"):
        return (
            {"action": "decline",
             "transaction": {"transactionId": txn_id, "declineReason": DECLINE_REASON_CANCELLED}},
            "order cancelled",
        )

    status = order.get("financial_status")

    if status == "refunded":
        return (
            {"action": "decline",
             "transaction": {"transactionId": txn_id, "declineReason": DECLINE_REASON_RETURNED}},
            "order fully refunded",
        )

    if status == "partially_refunded":
        txn_date = datetime.fromisoformat(txn["transactionDate"]).replace(tzinfo=timezone.utc)
        age_days = (now - txn_date).days
        if age_days < MIN_AMEND_AGE_DAYS:
            return None, f"partial refund, txn {age_days}d old — waiting until {MIN_AMEND_AGE_DAYS}d to amend once"
        if txn.get("amended"):
            return None, "partial refund but transaction already amended — Awin allows one amendment only"

        subtotal = float(order.get("subtotal_price") or 0)
        current = float(order.get("current_subtotal_price") or 0)
        if subtotal <= 0:
            return None, "zero original subtotal — skipped for manual review"
        fraction = max(0.0, min(current / subtotal, 1.0))
        if fraction >= 0.999:
            return None, "refund did not reduce product subtotal (shipping-only?) — left pending"
        if fraction <= 0.001:
            return (
                {"action": "decline",
                 "transaction": {"transactionId": txn_id, "declineReason": DECLINE_REASON_RETURNED}},
                "product subtotal fully refunded",
            )

        old_sale = float(txn["saleAmount"]["amount"])
        new_sale = round(old_sale * fraction, 2)
        parts = _scaled_parts(txn["transactionParts"], fraction, new_sale)
        return (
            {"action": "amend", "approve": False,
             "transaction": {
                 "transactionId": txn_id,
                 "amendReason": AMEND_REASON,
                 "currency": txn["saleAmount"]["currency"],
                 "saleAmount": new_sale,
                 "transactionParts": parts,
             }},
            f"partial refund: kept {fraction:.1%}, sale {old_sale:.2f} -> {new_sale:.2f}",
        )

    return None, f"clean ({status}) — leave for Awin auto-approval"


# ── Runner ───────────────────────────────────────────────────────────────────

def run(dry_run=True):
    """Run validation for both brands. Returns a summary dict."""
    clear_token_cache()
    summary = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "dry_run": dry_run,
        "brands": {},
    }
    for brand, cfg in brands().items():
        adv = cfg["advertiser_id"]
        pending = get_pending_transactions(adv)
        actions, decisions = [], []
        for txn in pending:
            order_ref = txn.get("orderRef")
            order = get_order(brand, order_ref) if order_ref and str(order_ref).isdigit() else None
            reason_prefix = "" if (order_ref and str(order_ref).isdigit()) else "non-numeric orderRef; "
            action, reason = decide(txn, order)
            decisions.append({
                "transactionId": txn["id"],
                "orderRef": order_ref,
                "transactionDate": txn["transactionDate"],
                "saleAmount": txn["saleAmount"]["amount"],
                "commission": txn["commissionAmount"]["amount"],
                "action": action["action"] if action else "leave-pending",
                "detail": reason_prefix + reason,
            })
            if action:
                actions.append(action)

        result = None
        if actions and not dry_run:
            result = post_validations(adv, actions)

        summary["brands"][brand] = {
            "pending": len(pending),
            "declines": sum(1 for a in actions if a["action"] == "decline"),
            "amends": sum(1 for a in actions if a["action"] == "amend"),
            "left_pending": len(pending) - len(actions),
            "submitted": bool(actions and not dry_run),
            "awin_response": result,
            "decisions": decisions,
        }
        log.info("[%s] pending=%d declines=%d amends=%d dry_run=%s",
                 brand, len(pending),
                 summary["brands"][brand]["declines"],
                 summary["brands"][brand]["amends"], dry_run)

    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    return summary
