CREATE TABLE IF NOT EXISTS sku_remap (
  shopify_sku        TEXT PRIMARY KEY,
  mirakl_sku         TEXT NOT NULL UNIQUE,
  suffix             TEXT NOT NULL DEFAULT '-V2',
  reason             TEXT,
  old_offer_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
  new_offer_created  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sku_remap_mirakl ON sku_remap(mirakl_sku);
