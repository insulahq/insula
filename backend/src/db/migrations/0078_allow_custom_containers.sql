-- Allow Custom Containers (BYO image) subscription gating + catalog app disable
-- (2026-07-30). Two independent admin controls:
--   1. hosting_plans.allow_custom_containers — plan-level toggle for the
--      ADR-036 custom-container (bring-your-own image) path. Default FALSE:
--      no plan grants it unless an admin opts in. Per-tenant override lives on
--      tenants.allow_custom_containers_override (NULL = inherit the plan).
--      Effective access = system customDeploymentsEnabled AND (override ?? plan).
--   2. catalog_entries.disabled — admin visibility flag alongside
--      featured/popular. When 1 the entry is hidden from the tenant catalog
--      listing; existing deployments are unaffected (they resolve their image
--      by primary-key id / the applied k8s spec, not the browse filter).
ALTER TABLE "hosting_plans"
  ADD COLUMN IF NOT EXISTS "allow_custom_containers" boolean NOT NULL DEFAULT false;
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "allow_custom_containers_override" boolean;
ALTER TABLE "catalog_entries"
  ADD COLUMN IF NOT EXISTS "disabled" integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "catalog_entries_disabled_idx" ON "catalog_entries" ("disabled");
