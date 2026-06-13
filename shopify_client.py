"""Shopify Admin GraphQL client for attribution-bridge (JOY).

Auth: client-credentials grant, same pattern as the warehouse refresh service.
"""
import hashlib
import os
import time

import requests

API_VERSION = "2024-10"
_token_cache = {}


def _domain():
    return os.environ["SHOPIFY_JOY_DOMAIN"]


def _get_token():
    cached = _token_cache.get("joy", {})
    if cached.get("token") and cached.get("expires_at", 0) > time.time():
        return cached["token"]
    r = requests.post(
        f"https://{_domain()}/admin/oauth/access_token",
        json={"client_id": os.environ["SHOPIFY_JOY_CLIENT_ID"],
              "client_secret": os.environ["SHOPIFY_JOY_CLIENT_SECRET"],
              "grant_type": "client_credentials"},
        timeout=20,
    )
    r.raise_for_status()
    token = r.json()["access_token"]
    _token_cache["joy"] = {"token": token, "expires_at": time.time() + 82800}
    return token


def graphql(query, variables=None):
    r = requests.post(
        f"https://{_domain()}/admin/api/{API_VERSION}/graphql.json",
        json={"query": query, "variables": variables or {}},
        headers={"X-Shopify-Access-Token": _get_token(),
                 "Content-Type": "application/json"},
        timeout=60,
    )
    r.raise_for_status()
    data = r.json()
    if data.get("errors"):
        raise RuntimeError(f"Shopify GraphQL errors: {data['errors']}")
    return data["data"]


ORDERS_QUERY = """
query($cursor: String, $q: String) {
  orders(first: 50, after: $cursor, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name legacyResourceId createdAt updatedAt test
      displayFinancialStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      customer {
        email phone firstName lastName
        defaultAddress { city provinceCode zip countryCodeV2 }
      }
      lineItems(first: 100) {
        nodes {
          quantity
          discountedTotalSet { shopMoney { amount } }
          variant { id inventoryItem { unitCost { amount } } }
        }
      }
      refunds {
        id createdAt
        totalRefundedSet { shopMoney { amount } }
      }
    }
  }
}
"""

CUSTOMERS_QUERY = """
query($cursor: String, $q: String) {
  customers(first: 250, after: $cursor, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes { email numberOfOrders amountSpent { amount } }
  }
}
"""


def fetch_orders_updated_since(iso_ts, max_pages=20):
    """Orders (with refunds embedded) updated since iso_ts, oldest first."""
    orders, cursor = [], None
    q = f"updated_at:>='{iso_ts}'"
    for _ in range(max_pages):
        data = graphql(ORDERS_QUERY, {"cursor": cursor, "q": q})
        block = data["orders"]
        orders.extend(block["nodes"])
        if not block["pageInfo"]["hasNextPage"]:
            break
        cursor = block["pageInfo"]["endCursor"]
    return [o for o in orders if not o.get("test")]


def fetch_purchaser_emails(min_orders=1, max_pages=40):
    """All customer emails with at least min_orders orders."""
    emails, cursor = [], None
    q = f"orders_count:>={min_orders}"
    for _ in range(max_pages):
        data = graphql(CUSTOMERS_QUERY, {"cursor": cursor, "q": q})
        block = data["customers"]
        for c in block["nodes"]:
            if c.get("email"):
                emails.append(c["email"])
        if not block["pageInfo"]["hasNextPage"]:
            break
        cursor = block["pageInfo"]["endCursor"]
    return emails


def sha256_norm(value):
    """Meta/Google-style normalisation: lowercase, strip, SHA-256 hex."""
    if not value:
        return None
    return hashlib.sha256(str(value).strip().lower().encode()).hexdigest()


def order_profit_ex_vat(order, vat_rate=1.2):
    """Profit = sum(line revenue ex VAT - units*unit cost) over lines with cost.

    Returns (profit, cost_coverage) where cost_coverage is the share of line
    revenue that had a unit cost available. unitCost in Shopify is ex VAT.
    """
    covered_rev, total_rev, profit = 0.0, 0.0, 0.0
    for li in order["lineItems"]["nodes"]:
        rev = float(li["discountedTotalSet"]["shopMoney"]["amount"])
        total_rev += rev
        variant = li.get("variant") or {}
        unit_cost = ((variant.get("inventoryItem") or {}).get("unitCost") or {}).get("amount")
        if unit_cost is None:
            continue
        covered_rev += rev
        profit += rev / vat_rate - float(unit_cost) * li["quantity"]
    coverage = covered_rev / total_rev if total_rev else 0.0
    return round(profit, 2), round(coverage, 3)
