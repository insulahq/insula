-- migration 0073 — Phase 2: activate usage_metrics as the historical rollup store.
--
-- The usage_metrics table existed but had NO writer (dead scaffolding). Phase 2
-- turns it into a bounded, reaped time-series: the hourly metrics-scheduler writes
-- one aggregate row per (tenant, metric_type, hour); a daily reaper folds hourly
-- rows older than 30d into daily rows (kept 1y) and purges the rest. This prevents
-- unbounded growth while giving billing-grade bandwidth history + capacity charts.

-- Widen value: daily bandwidth folds SUM hourly GB deltas, which can exceed the
-- old numeric(10,4) headroom on a busy tenant.
ALTER TABLE usage_metrics ALTER COLUMN value TYPE numeric(14, 4);

-- Rollup resolution: 'hourly' (default, 30d) folded to 'daily' (1y).
-- Bare CREATE TYPE — the migrate runner tolerates 42710 (duplicate_object) on re-run.
CREATE TYPE usage_resolution AS ENUM ('hourly', 'daily');
ALTER TABLE usage_metrics ADD COLUMN IF NOT EXISTS resolution usage_resolution NOT NULL DEFAULT 'hourly';

-- Upsert target for the hourly writer + daily fold. Rollup rows are
-- tenant-aggregate (deployment_id NULL), so the key omits deployment_id.
CREATE UNIQUE INDEX IF NOT EXISTS usage_metrics_bucket_uniq
  ON usage_metrics (tenant_id, metric_type, resolution, measurement_timestamp);
