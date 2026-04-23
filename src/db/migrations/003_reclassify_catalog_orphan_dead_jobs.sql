-- Migration 003: Reclassify legacy dead stock_update jobs as 'skipped' where
-- the failure matches the catalog_orphan pattern introduced in the
-- TerminalMiraklError classifier. Raise one info-severity catalog_orphan alert
-- per reclassified job so the transition is visible in the nightly audit.
--
-- Idempotent: safe to re-run. Uses WHERE NOT EXISTS on the alert insert keyed
-- on jobId, and only flips jobs still in 'dead' state. Wrapped in a single
-- transaction so partial failure cannot leave jobs reclassified without the
-- corresponding alert rows.

BEGIN;

-- Stage: identify dead stock_update jobs whose last_error matches the
-- Mirakl rejection signature we now classify as terminal catalog_orphan.
WITH targets AS (
  SELECT id, payload, last_error
    FROM jobs
   WHERE status = 'dead'
     AND job_type = 'stock_update'
     AND last_error LIKE '%rejected stock update for%'
),
reclassified AS (
  UPDATE jobs
     SET status = 'skipped',
         last_error = COALESCE(last_error, '') || ' [reclassified by migration 003]',
         completed_at = COALESCE(completed_at, NOW())
   WHERE id IN (SELECT id FROM targets)
  RETURNING id, job_type, payload, last_error
)
INSERT INTO alerts (severity, category, message, metadata, dispatched)
SELECT
  'info',
  'catalog_orphan',
  'stock_update reclassified for ' || COALESCE(payload->>'sku', 'unknown') || ': ' || last_error,
  jsonb_build_object(
    'jobId',      id,
    'jobType',    job_type,
    'code',       'catalog_orphan',
    'sku',        payload->>'sku',
    'source',     'migration_003',
    'note',       'Backfill: pre-classifier dead stock_update reclassified as skipped'
  ),
  TRUE  -- mark dispatched so the backfill doesn't page/slack the operator
  FROM reclassified r
 WHERE NOT EXISTS (
        SELECT 1 FROM alerts a
         WHERE a.category = 'catalog_orphan'
           AND (a.metadata->>'jobId')::bigint = r.id
           AND (a.metadata->>'source')      = 'migration_003'
      );

COMMIT;
