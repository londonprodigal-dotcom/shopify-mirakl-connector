-- Migration 004: pending_catalog — tracks SKUs that the stockUpdate classifier
-- marked 'skipped' (TerminalMiraklError / catalog_orphan). The resurrection
-- poller (hourly) compares these against a fresh OF52 Mirakl offer export; any
-- SKU that now appears as an active offer gets re-enqueued as a stock_update
-- with its current Shopify qty. Mitigates the PA01-race silent-drift risk:
-- Shopify inventory webhooks only fire on qty change, so without this poller
-- a newly-accepted SKU could sit on stale stock on Debenhams until the next
-- movement.
--
-- The webhook-level dedupe (Phase B2) will also read this table to short-circuit
-- enqueue of stock_update jobs for known-orphan SKUs.

CREATE TABLE IF NOT EXISTS pending_catalog (
  sku              TEXT        PRIMARY KEY,
  last_qty         INTEGER     NOT NULL,
  error_code       TEXT        NOT NULL,            -- e.g. 'catalog_orphan'
  mirakl_error_msg TEXT,                            -- raw Mirakl message for telemetry
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts         INTEGER     NOT NULL DEFAULT 1,
  last_poll_at     TIMESTAMPTZ,                     -- set by resurrection_poll on sweep
  resolved_at      TIMESTAMPTZ                      -- set when re-enqueued via resurrection
);

-- Partial indexes only cover the hot path (unresolved rows).
CREATE INDEX IF NOT EXISTS idx_pending_catalog_unresolved
  ON pending_catalog (sku) WHERE resolved_at IS NULL;

-- Webhook-touched subset: rows where a webhook has been seen since the last
-- poll (or never polled). This is what the resurrection sweep iterates.
CREATE INDEX IF NOT EXISTS idx_pending_catalog_webhook_touched
  ON pending_catalog (last_seen_at) WHERE resolved_at IS NULL;
