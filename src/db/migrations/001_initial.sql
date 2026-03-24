CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  source TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source, received_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT REFERENCES events(id),
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  last_error TEXT,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(run_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_correlation ON jobs(correlation_id);

CREATE TABLE IF NOT EXISTS order_map (
  id BIGSERIAL PRIMARY KEY,
  mirakl_order_id TEXT NOT NULL UNIQUE,
  shopify_order_id BIGINT,
  shopify_order_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_ledger (
  sku TEXT PRIMARY KEY,
  shopify_qty INT,
  mirakl_qty INT,
  buffer_applied INT NOT NULL DEFAULT 0,
  last_pushed_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  drift_detected BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  dispatched BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_undispatched ON alerts(created_at) WHERE dispatched = FALSE;
