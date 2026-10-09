-- Tenant node-disk limits (ROADMAP R37).
--
-- Every tenant container gets an `ephemeral-storage` limit — its writable
-- layer, /tmp and logs together — so one tenant can no longer fill a node's
-- disk for every other tenant on it. The two values are operator-tunable on
-- the admin Limits page; the deployers read them when they render a pod.
--
--   tenant_app_disk_limit_mb       every tenant container that is not a database
--   tenant_database_disk_limit_mb  database components: sorts and temp tables
--                                  that do not fit in memory spill to disk
--
-- Bounds (256..65536) are enforced by the PATCH schema and again by the reader,
-- which falls back to these defaults rather than ever rendering a 0.
--
-- Additive with a DEFAULT, so pods still running the previous release keep
-- working during the rollout (their schema does not select these columns).
ALTER TABLE "system_settings"
  ADD COLUMN IF NOT EXISTS "tenant_app_disk_limit_mb" INTEGER NOT NULL DEFAULT 2048;--> statement-breakpoint
ALTER TABLE "system_settings"
  ADD COLUMN IF NOT EXISTS "tenant_database_disk_limit_mb" INTEGER NOT NULL DEFAULT 8192;
