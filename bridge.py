"""attribution-bridge core cycles.

Order/refund cycle (every 15 min):
  - Meta CAPI Purchase, deduped against the browser pixel by
    event_id = shopify_order_<id>  (gated: ENABLE_META_PURCHASE)
  - Meta CAPI ProfitPurchase custom event with ex-VAT margin value
    (gated: ENABLE_PROFIT_EVENT; no dedupe risk, nothing else sends it)
  - Google Ads conversion adjustments for refunds by order_id
    (gated: ENABLE_GOOGLE_ADJ)

Audience cycle (daily):
  - Meta custom audience + Google Customer Match list from Shopify
    purchaser emails and Klaviyo subscribed profiles
    (gates: ENABLE_META_AUDIENCES, ENABLE_GOOGLE_CM)

DRY_RUN=true logs every action without sending. Flags are read per cycle so
they can be flipped via Railway variables without a redeploy.
"""
import os
import traceback
from datetime import datetime, timedelta, timezone

import requests

import gads_client
import meta_client
import shopify_client
import state

LOG_RING = []


def log(msg):
    line = f"{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    LOG_RING.append(line)
    del LOG_RING[:-400]


def flag(name, default="false"):
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes")


def dry_run():
    return flag("DRY_RUN", "true")


def order_cycle():
    """Pull recently updated orders; send purchase/profit events + refund adjustments."""
    dry = dry_run()
    watermark = state.get("orders_watermark")
    if not watermark:
        watermark = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    cycle_start = datetime.now(timezone.utc)

    orders = shopify_client.fetch_orders_updated_since(watermark)
    log(f"cycle: {len(orders)} orders updated since {watermark} (dry_run={dry})")

    counts = {"purchase": 0, "profit": 0, "refund_adj": 0, "skipped": 0, "errors": 0}
    for order in orders:
        try:
            _process_order(order, dry, counts)
        except Exception as e:
            counts["errors"] += 1
            log(f"ERROR order {order.get('name')}: {e}")
            traceback.print_exc()

    # advance watermark with a 30-min overlap; sent_events ledger dedupes
    new_wm = (cycle_start - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    state.set_("orders_watermark", new_wm)
    state.set_("last_cycle", cycle_start.isoformat())
    state.set_("last_cycle_counts", str(counts))
    log(f"cycle done: {counts}")
    return counts


def _process_order(order, dry, counts):
    oid = order["legacyResourceId"]
    currency = order["currentTotalPriceSet"]["shopMoney"]["currencyCode"]
    value = float(order["currentTotalPriceSet"]["shopMoney"]["amount"])
    user_data = meta_client.build_user_data(order, shopify_client.sha256_norm)

    if not user_data.get("em"):
        counts["skipped"] += 1
        return

    # 1. server-fired Purchase (deduped against pixel by event_id)
    if flag("ENABLE_META_PURCHASE"):
        key = f"meta_purchase:{oid}"
        if not state.already_sent(key):
            ev = meta_client.purchase_event(order, user_data, value, currency)
            if dry:
                log(f"DRY purchase {order['name']} value={value} em={'em' in user_data} "
                    f"keys={sorted(user_data)}")
            else:
                tec = os.environ.get("META_TEST_EVENT_CODE") or None
                meta_client.send_events([ev], test_event_code=tec)
            state.mark_sent(key, dry, f"value={value}")
            counts["purchase"] += 1

    # 2. ProfitPurchase with ex-VAT margin value
    if flag("ENABLE_PROFIT_EVENT"):
        key = f"meta_profit:{oid}"
        if not state.already_sent(key):
            profit, coverage = shopify_client.order_profit_ex_vat(order)
            if coverage >= 0.9:
                ev = meta_client.purchase_event(
                    order, user_data, profit, currency,
                    event_name="ProfitPurchase",
                    event_id=f"shopify_profit_{oid}")
                if dry:
                    log(f"DRY profit {order['name']} profit={profit} coverage={coverage}")
                else:
                    tec = os.environ.get("META_TEST_EVENT_CODE") or None
                    meta_client.send_events([ev], test_event_code=tec)
                state.mark_sent(key, dry, f"profit={profit} cov={coverage}")
                counts["profit"] += 1
            else:
                log(f"profit skipped {order['name']}: cost coverage {coverage}")

    # 3. refund adjustments to Google
    if flag("ENABLE_GOOGLE_ADJ") and order.get("refunds"):
        for refund in order["refunds"]:
            rid = refund["id"].split("/")[-1]
            key = f"gads_adj:{rid}"
            if state.already_sent(key):
                continue
            refunded = float(refund["totalRefundedSet"]["shopMoney"]["amount"])
            if refunded <= 0:
                continue
            remaining = max(0.0, value)  # currentTotalPrice is already net of refunds
            full_refund = remaining <= 0.01
            if dry:
                log(f"DRY refund-adj {order['name']} refund={refunded} "
                    f"{'RETRACTION' if full_refund else f'RESTATEMENT->{remaining}'}")
                state.mark_sent(key, True, f"refund={refunded}")
            else:
                ca = gads_client.find_purchase_conversion_action(state.get, state.set_)
                ok, msg = gads_client.upload_refund_adjustment(
                    ca, oid, refund["createdAt"],
                    restated_value=None if full_refund else remaining,
                    currency=currency)
                state.mark_sent(key, False, msg)
                if not ok:
                    log(f"refund-adj partial failure {order['name']}: {msg}")
            counts["refund_adj"] += 1


# ── Audiences ────────────────────────────────────────────────────────────────

AUD_PURCHASERS = "JOY Purchasers (attribution-bridge)"
AUD_SUBSCRIBERS = "JOY Subscribers (attribution-bridge)"


def _klaviyo_subscribed_emails(max_pages=1000):
    """Members of the main newsletter list (largest list = ground truth for
    subscribers), falling back to a subscribed-profiles scan."""
    key = os.environ["KLAVIYO_JOY_API_KEY"]
    headers = {"Authorization": f"Klaviyo-API-Key {key}",
               "accept": "application/json", "revision": "2024-10-15"}

    list_id = os.environ.get("KLAVIYO_JOY_LIST_ID") or state.get("klaviyo_list_id")
    if not list_id:
        r = requests.get("https://a.klaviyo.com/api/lists/",
                         headers=headers, timeout=30)
        r.raise_for_status()
        lists = r.json().get("data", [])
        # pick the newsletter list by name, else first list
        chosen = None
        for l in lists:
            name = (l.get("attributes", {}).get("name") or "").lower()
            if "newsletter" in name or "subscriber" in name or "master" in name:
                chosen = l["id"]
                break
        if not chosen and lists:
            chosen = lists[0]["id"]
        if not chosen:
            return []
        list_id = chosen
        state.set_("klaviyo_list_id", list_id)
        log(f"  klaviyo list selected: {list_id}")

    emails = []
    url = f"https://a.klaviyo.com/api/lists/{list_id}/profiles/?page[size]=100"
    for _ in range(max_pages):
        r = requests.get(url, headers=headers, timeout=30)
        r.raise_for_status()
        body = r.json()
        for p in body.get("data", []):
            em = p.get("attributes", {}).get("email")
            if em:
                emails.append(em)
        url = (body.get("links") or {}).get("next")
        if not url:
            break
    return emails


def audience_cycle():
    dry = dry_run()
    results = {}

    log("audience cycle: pulling Shopify purchasers")
    purchasers = shopify_client.fetch_purchaser_emails()
    log(f"  {len(purchasers)} purchaser emails")
    log("audience cycle: pulling Klaviyo subscribed profiles")
    try:
        subscribers = _klaviyo_subscribed_emails()
    except Exception as e:
        log(f"  klaviyo pull failed: {e}")
        subscribers = []
    log(f"  {len(subscribers)} subscribed emails")

    for aud_name, emails in ((AUD_PURCHASERS, purchasers), (AUD_SUBSCRIBERS, subscribers)):
        if not emails:
            continue
        hashes = sorted({shopify_client.sha256_norm(e) for e in emails if e})
        new = state.audience_new_members(aud_name, hashes)
        results[aud_name] = {"total": len(hashes), "new": len(new)}
        if not new:
            continue
        if dry:
            log(f"DRY audience {aud_name}: would add {len(new)} (of {len(hashes)})")
            continue
        if flag("ENABLE_META_AUDIENCES"):
            try:
                aid = meta_client.ensure_audience(
                    aud_name, "Synced daily by attribution-bridge",
                    state.get, state.set_)
                n = meta_client.add_audience_users(aid, new)
                log(f"meta audience {aud_name}: +{n}")
            except Exception as e:
                log(f"meta audience {aud_name} failed: {e}")
        if flag("ENABLE_GOOGLE_CM"):
            try:
                ul = gads_client.ensure_customer_match_list(
                    aud_name, state.get, state.set_)
                gads_client.add_customer_match_members(ul, new)
                log(f"google CM {aud_name}: +{len(new)} (job running)")
            except Exception as e:
                log(f"google CM {aud_name} failed: {e}")
        if flag("ENABLE_META_AUDIENCES") or flag("ENABLE_GOOGLE_CM"):
            state.audience_record_members(aud_name, new)

    state.set_("last_audience_cycle", datetime.now(timezone.utc).isoformat())
    state.set_("last_audience_results", str(results))
    log(f"audience cycle done: {results}")
    return results
