-- Admin-adjustable retention (grace) window for a DELETED tenant's off-site
-- backup bundles (2026-07-16). Pairs with migration 0070 (loose FK so the
-- bundle rows survive tenant deletion). On delete, the tenant-bundles-cleanup
-- hook floors every reap-eligible bundle's expires_at to now + this many days
-- (extend-never-shorten); the retention.ts reaper then deletes them once the
-- window passes. Default 30 days matches the historical per-bundle default.
ALTER TABLE "system_settings"
  ADD COLUMN IF NOT EXISTS "deleted_tenant_bundle_retention_days" integer NOT NULL DEFAULT 30;
