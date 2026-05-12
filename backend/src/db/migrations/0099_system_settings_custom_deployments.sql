-- ADR-036 custom-deployments operator toggles on system_settings.
--
-- All flags default to permissive (feature on) so the platform ships
-- a working surface out of the box. Operators tighten by flipping.
-- The reserved scan-on-pull column is set up here as a no-op so that
-- enabling Trivy in Phase 2 is a code-only change.
--
-- POLICY NOTE — permissive defaults:
--   `custom_deployments_allow_private_registries = TRUE` ships
--   permissive. Operators with a regulatory or contractual obligation
--   to require explicit opt-in for tenant-supplied PAT submission
--   MUST flip this to FALSE after this migration runs. The platform
--   ships permissive because the feature is opt-in at the tenant
--   side (a tenant must declare a PAT) and the platform's defense
--   against malicious images is Pod-isolation, not registry-allowlist.
--   See ADR-036 §Image Trust for the user-confirmed trade-offs.

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS custom_deployments_enabled boolean NOT NULL DEFAULT TRUE;

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS custom_deployments_allow_compose boolean NOT NULL DEFAULT TRUE;

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS custom_deployments_allow_private_registries boolean NOT NULL DEFAULT TRUE;

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS custom_deployments_image_pull_audit boolean NOT NULL DEFAULT TRUE;

-- Phase-2 reservation: column exists, server-side scan stays a no-op
-- in Phase 1. Flipping this on without a Trivy CronJob in place has
-- no effect.
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS custom_deployments_scan_on_pull boolean NOT NULL DEFAULT FALSE;

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS custom_deployments_warn_unpinned_tags boolean NOT NULL DEFAULT TRUE;
