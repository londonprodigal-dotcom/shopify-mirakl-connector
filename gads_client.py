"""Google Ads client for attribution-bridge: refund conversion adjustments +
Customer Match list sync. Both gated behind ENABLE_ flags until verified."""
import os
from datetime import datetime, timezone


def _client():
    from google.ads.googleads.client import GoogleAdsClient
    cfg = {
        "developer_token": os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        "client_id": os.environ["GOOGLE_ADS_OAUTH_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_ADS_OAUTH_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_ADS_OAUTH_REFRESH_TOKEN"],
        "login_customer_id": os.environ["GOOGLE_ADS_LOGIN_CUSTOMER_ID"].replace("-", ""),
        "use_proto_plus": True,
    }
    return GoogleAdsClient.load_from_dict(cfg)


def _customer_id():
    return os.environ["GOOGLE_ADS_JOY_CUSTOMER_ID"].replace("-", "")


def find_purchase_conversion_action(state_get, state_set):
    """Discover the web purchase conversion action; cache resource name."""
    key = "gads_purchase_conversion_action"
    cached = state_get(key)
    if cached:
        return cached
    client = _client()
    svc = client.get_service("GoogleAdsService")
    query = """
        SELECT conversion_action.resource_name, conversion_action.name,
               conversion_action.type, conversion_action.status,
               conversion_action.category
        FROM conversion_action
        WHERE conversion_action.status = 'ENABLED'
          AND conversion_action.category = 'PURCHASE'
    """
    rows = list(svc.search(customer_id=_customer_id(), query=query))
    if not rows:
        raise RuntimeError("no enabled PURCHASE conversion action found")
    # Prefer the Shopify channel / primary web purchase action
    best = None
    for row in rows:
        name = row.conversion_action.name.lower()
        if "shopify" in name or "purchase" in name:
            best = row.conversion_action.resource_name
            break
    best = best or rows[0].conversion_action.resource_name
    state_set(key, best)
    return best


def upload_refund_adjustment(conversion_action, order_id, refund_iso,
                             restated_value=None, currency="GBP"):
    """RETRACTION (full refund) or RESTATEMENT (partial, with new value) by order_id.

    Returns (ok, message).
    """
    client = _client()
    svc = client.get_service("ConversionAdjustmentUploadService")
    adj = client.get_type("ConversionAdjustment")
    adj.conversion_action = conversion_action
    adj.order_id = str(order_id)
    ts = datetime.fromisoformat(refund_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    adj.adjustment_date_time = ts.strftime("%Y-%m-%d %H:%M:%S+00:00")
    if restated_value is None:
        adj.adjustment_type = client.enums.ConversionAdjustmentTypeEnum.RETRACTION
    else:
        adj.adjustment_type = client.enums.ConversionAdjustmentTypeEnum.RESTATEMENT
        adj.restatement_value.adjusted_value = float(restated_value)
        adj.restatement_value.currency_code = currency
    request = client.get_type("UploadConversionAdjustmentsRequest")
    request.customer_id = _customer_id()
    request.conversion_adjustments.append(adj)
    request.partial_failure = True
    resp = svc.upload_conversion_adjustments(request=request)
    if resp.partial_failure_error and resp.partial_failure_error.message:
        return False, resp.partial_failure_error.message[:300]
    return True, "ok"


# ── gclid → campaign ─────────────────────────────────────────────────────────

def resolve_gclids(pending, lookback_days=2):
    """Map gclids to their campaign via the click_view report.

    click_view has two hard constraints: exactly one day per query, and a
    90-day lookback. Clicks usually land on or just before the order date, so
    each order date is expanded to itself plus `lookback_days` before it, the
    set of dates is deduped, and each is queried once.

    `pending` is a list of {gclid, order_id, order_date}. Returns a dict of
    gclid -> {campaign_id, campaign_name, ad_group_id, ad_group_name,
    click_date}, containing only the gclids actually found.
    """
    from datetime import date, timedelta

    wanted = {p["gclid"] for p in pending if p.get("gclid")}
    if not wanted:
        return {}

    dates = set()
    today = datetime.now(timezone.utc).date()
    horizon = today - timedelta(days=89)
    for p in pending:
        raw = (p.get("order_date") or "")[:10]
        try:
            d = date.fromisoformat(raw)
        except ValueError:
            continue
        for back in range(lookback_days + 1):
            day = d - timedelta(days=back)
            if horizon <= day <= today:
                dates.add(day)

    if not dates:
        return {}

    client = _client()
    svc = client.get_service("GoogleAdsService")
    found = {}
    for day in sorted(dates, reverse=True):
        query = f"""
            SELECT click_view.gclid, campaign.id, campaign.name,
                   ad_group.id, ad_group.name, segments.date
            FROM click_view
            WHERE segments.date = '{day.isoformat()}'
        """
        try:
            for row in svc.search(customer_id=_customer_id(), query=query):
                gclid = row.click_view.gclid
                if gclid and gclid in wanted and gclid not in found:
                    found[gclid] = {
                        "campaign_id": str(row.campaign.id),
                        "campaign_name": row.campaign.name,
                        "ad_group_id": str(row.ad_group.id),
                        "ad_group_name": row.ad_group.name,
                        "click_date": row.segments.date,
                    }
        except Exception as e:  # one bad day must not sink the whole cycle
            raise RuntimeError(f"click_view {day.isoformat()} failed: {e}") from e
        if len(found) == len(wanted):
            break
    return found


# ── Customer Match ───────────────────────────────────────────────────────────

def ensure_customer_match_list(name, state_get, state_set):
    key = f"gads_cm_list:{name}"
    cached = state_get(key)
    if cached:
        return cached
    client = _client()
    svc = client.get_service("UserListService")
    op = client.get_type("UserListOperation")
    ul = op.create
    ul.name = name
    ul.description = "Synced by attribution-bridge (hashed emails)"
    ul.membership_life_span = 540
    ul.crm_based_user_list.upload_key_type = (
        client.enums.CustomerMatchUploadKeyTypeEnum.CONTACT_INFO)
    resp = svc.mutate_user_lists(customer_id=_customer_id(), operations=[op])
    resource = resp.results[0].resource_name
    state_set(key, resource)
    return resource


def add_customer_match_members(user_list, em_hashes):
    """Append hashed emails via OfflineUserDataJob. Returns job resource name."""
    client = _client()
    svc = client.get_service("OfflineUserDataJobService")
    job = client.get_type("OfflineUserDataJob")
    job.type_ = client.enums.OfflineUserDataJobTypeEnum.CUSTOMER_MATCH_USER_LIST
    job.customer_match_user_list_metadata.user_list = user_list
    create_resp = svc.create_offline_user_data_job(
        customer_id=_customer_id(), job=job)
    job_resource = create_resp.resource_name

    operations = []
    for h in em_hashes:
        op = client.get_type("OfflineUserDataJobOperation")
        op.create.user_identifiers.add().hashed_email = h
        operations.append(op)

    # add in chunks of 10k per request (API limit ~100k identifiers/job)
    for i in range(0, len(operations), 10000):
        req = client.get_type("AddOfflineUserDataJobOperationsRequest")
        req.resource_name = job_resource
        req.operations.extend(operations[i:i + 10000])
        req.enable_partial_failure = True
        svc.add_offline_user_data_job_operations(request=req)

    svc.run_offline_user_data_job(resource_name=job_resource)
    return job_resource
