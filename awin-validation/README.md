# Awin Commission Validation — How It Works

*Internal reference note. Written 7 July 2026.*

## What this is

An automated service that stops us paying Awin affiliate commission on
orders that were returned or cancelled. It replaces the manual monthly
validation that Fairforecast used to do before they left.

It runs on Railway (service `awin-validation` in the `business-data-refresh`
project), once a day at 5am UTC, covering both JOY and Louche. Nothing runs
on any local machine.

## The background, in one paragraph

When a customer buys through an affiliate link, Awin records a "pending"
transaction. Pending transactions sit for roughly 30 days and then
auto-approve, at which point the commission becomes payable and cannot be
taken back. The Awin Shopify app already declines commission on cancelled
orders by itself, and catches some refunds, but it is not reliable on
returns. Anything it misses used to be picked up by the agency's monthly
sweep. That is the gap this service fills.

## What it does each day

1. Pulls every pending Awin transaction from the last 75 days, both brands.
2. Looks up each one's order in Shopify (the Awin order reference is the
   Shopify order ID, so matching is exact).
3. Then, for each transaction:
   - **Order cancelled** → commission declined ("Cancelled in Shopify").
   - **Order fully refunded** → commission declined ("Returned in Shopify").
   - **Order partially refunded** → the recorded sale amount is reduced in
     proportion to what the customer kept, so commission is only paid on the
     kept items. This happens once the transaction is at least 25 days old,
     because Awin only allows one amendment per transaction, and waiting
     until day 25 catches any follow-up returns on the same order before the
     30-day auto-approval.
   - **Order untouched** → left alone. Awin auto-approves it at ~30 days.
     The service never approves anything itself.

Everything it decides is logged, and each day's summary is visible at the
health endpoint (below).

## What is still manual

**Publisher transaction queries.** These are the "you have X transaction
queries that will auto approve within N days" emails from Awin. A query is a
publisher claiming commission on a sale they say went untracked. If nobody
responds within 75 days, Awin approves the claim and we pay it. These cannot
be handled through the advertiser API, so they need a couple of minutes in
the Awin dashboard whenever one of those emails arrives. They are rare.

## How to check on it

- Health and last run summary:
  https://awin-validation-production.up.railway.app/health
- Full logs: Railway dashboard → business-data-refresh → awin-validation.
- On Awin itself: amended transactions show the reason "Partial return in
  Shopify", declines show "Returned in Shopify".

## How to switch it off or change behaviour

All via Railway service variables (change → service redeploys):

- `DRY_RUN=true` — runs and logs decisions but writes nothing to Awin.
  This is the off switch.
- `MIN_AMEND_AGE_DAYS` — how old a transaction must be before a partial
  refund is amended (currently 25).
- `RUN_AT_UTC` — daily run time (currently 05:00).

A run can also be triggered on demand by POSTing to `/run` with the
`X-API-Key` header (key is `AWIN_VALIDATION_API_KEY` in
`C:\Users\djech\credentials\env\shared.env`).

## Things worth knowing

- Declines and amendments on Awin are permanent. There is no undo. This is
  why partial refunds wait until day 25 rather than acting immediately.
- Awin records sales excluding VAT while Shopify includes it. The service
  never converts amounts directly; it scales Awin's own figure by the
  fraction of the order the customer kept, so the VAT question never arises.
- If a return completes more than ~30 days after the order, the commission
  has usually already auto-approved and cannot be recovered. Asking Awin to
  extend the validation window to 45 days would close this; not yet done.
- The Awin API token lives in `shared.env` (`AWIN_API_TOKEN`) and is also
  set on the Railway service. Shopify access uses the same app credentials
  as the warehouse refresh.
- First live run (7 July 2026) amended three JOY partial returns and saved
  £13.61 in commission. Expected ongoing saving is modest but permanent —
  roughly £15–30 a month at current return rates.
