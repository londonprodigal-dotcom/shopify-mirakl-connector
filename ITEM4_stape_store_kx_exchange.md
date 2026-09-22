# Item 4 — Server-side identity store (Stape Store + Klaviyo _kx → email exchange)

> **STATUS, corrected 2026-09-22. Read this before the plan below — two of its
> claims are wrong and Part C is already built.**
>
> **Part C (Klaviyo _kx → email) IS BUILT**, and not the way this doc describes.
> It shipped in the theme + `joy-purchase-relay` instead of Stape Store:
> `snippets/gtm-datalayer.liquid` v6 (2026-08-28) posts to `/kx-resolve`, and
> the relay resolves and banks hashes. It also covers **phone** (v8), the
> durable Klaviyo profile id `kl_pid` (v9) and the Shopify browser id (v12/v13)
> — broader than the plan below. `em_map` on the relay holds 839 rows, 421 keyed
> by browser id, 219 of those with a phone. Do not rebuild it.
>
> **Part B (server-side enrichment at event time) is the ONLY piece still
> missing**, and it is the one that matters: today the banked identity only
> reaches Meta by being handed back to the browser as a cookie, which Safari
> caps at 7 days regardless of the 90-day max-age. Enriching inside the server
> container removes the browser from that loop entirely.
>
> **"Can't be fully automated via API" is WRONG.** Tested 2026-09-22:
> `templates.create` with the raw .tpl from `stape-io/stape-store-restore-variable`
> succeeded (template 81, registered as MACRO, `cvt_252458444_81`). Creating a
> variable of that type then failed with
> `vendorTemplate.parameter.stapeStoreContainerApiKey: The value must not be empty`
> — a **parameter validation** error, not "Unknown entity type". GTM accepted the
> side-loaded template and validated its fields. The 2026-05-21 Pinterest note
> below does not generalise.
>
> **The actual blocker is one credential.** A gallery import makes Stape wire the
> Stape Store container API key in automatically; a side-loaded copy must be
> given it. That key is NOT retrievable through the Stape management API —
> `/containers/{id}/stores` and `/containers/{id}/power-ups/storage` both 404,
> `get_power_up` has no `storage` type, and `stape_raw_request` refuses api-key
> paths by design. It has to come from the Stape dashboard → Stores.
>
> So the remaining manual step is **fetching one API key**, not importing
> templates. With that key in hand the rest of Part B is API-doable.

Goal: persist `email-hash ↔ FPID/client_id ↔ external_id` server-side so a customer
identified once on any device gets enriched CAPI events on later cookieless visits,
and resolve Klaviyo's `_kx` click identifier into a hashed email server-side without
PII ever touching the browser.

~~This is the ONE item in the 5 that can't be fully automated via API:~~
~~No Stape API token is stored on disk (only the GTM/CAPI tokens)~~ — a
STAPE_API_TOKEN has existed in shared.env since 2026-09-06 and is now also set
on the attribution-bridge service.

~~Side-loading a `.tpl` via the GTM API gets the template object but tag/variable
`.create` fails with "Unknown entity type" (confirmed 2026-05-21, Pinterest).~~
Disproved 2026-09-22 — see the status block above. Side-loading registers the
type fine; only the `stapeStoreContainerApiKey` parameter stops variable
creation, and that is a credential problem, not an API limitation.

What remains true: the Stape Store container API key itself has to be read out
of the Stape dashboard, because the management API does not expose it.

## Part A — Enable Stape Store (dashboard, ~3 min)
1. Stape dashboard → container `yrquagyh` → **Stores** (a.k.a. Stape Store / Power-Ups).
2. Enable **Store**. Note the auto-created store credentials (URL + key) — Stape wires
   these into the server container automatically; you don't copy them anywhere.
3. In the **sGTM container** (GTM-K83QR9XN), Templates → **Search Gallery** → import:
   - "Stape Store" variable template (stape-io)
   - "Data Tag" + "Data Client" (stape-io) if not already present
   Importing from the gallery is required (registers the signed ID server-side).

## Part B — Persist identity graph (sGTM, after Part A)
In the sGTM container, add to the **Meta CAPI - JOY** tag (id 14) flow:
1. New **Stape Store** variable `Store - email_by_fpid`:
   - Operation: GET, key = `em:{{FPID}}` (or client_id).
2. On any event that already carries a hashed email (Purchase, or the `identify`
   event from the theme v5 snippet), a **Data Tag** writes it back:
   - Operation: SET, key = `em:{{FPID}}`, value = `{{user_data.sha256_email_address}}`,
     TTL ~180d.
3. In the CAPI tag user_data, fall back to `{{Store - email_by_fpid}}` when the event's
   own email is empty. This is the cookieless enrichment.

## Part C — Klaviyo _kx → email exchange (sGTM)
The theme already captures `_kx` into the data layer (v3 in gtm-datalayer.liquid) and
forwards it to the server as `user_data.klaviyo_kx`.
1. New **Stape Store** variable `Store - email_by_kx` (GET, key = `kx:{{klaviyo_kx}}`).
2. A small **API Call / Data Tag** that, when `email_by_kx` is empty but `klaviyo_kx`
   is present, calls Klaviyo:
   `GET https://a.klaviyo.com/client/profiles or /api/profiles?filter=...`
   resolving the `_kx` to the profile, hashes the email server-side, then SET
   `kx:{{klaviyo_kx}}` = hash (TTL ~180d) so it's a one-time lookup per visitor.
   - Use a **restricted** Klaviyo key for this (read profiles only).
3. Feed the resolved hash into CAPI user_data the same way as Part B.

Net effect: email-click visitors (Klaviyo's most identifiable cohort, currently
anonymous until checkout) become fully matched server-side, and repeat visitors stay
matched after their cookies expire.

## Why the attribution-bridge doesn't do this instead
The bridge enriches *purchases* (it has the order's customer record). Parts B/C enrich
*pre-purchase browse events* that flow through the sGTM CAPI tag in real time — a
different point in the pipeline. They're complementary.
