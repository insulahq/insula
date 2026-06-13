-- R1 PR 2: Plesk migration — provisioning one subscription onto the platform.
--
-- A `plesk_migration` provisions a SINGLE Plesk subscription (frozen as a
-- snapshot at create-time, so a later re-discovery can't change what we
-- build) into a platform tenant. The `legs` jsonb records per-leg progress
-- (tenant → domains → email; content/db/mail legs land in later PRs) so the
-- run is resumable: a backend restart mid-run leaves completed legs intact
-- and re-running skips them. NOTHING here touches the Plesk source — it is
-- platform-side provisioning driven by the read-only discovery inventory.

CREATE TABLE IF NOT EXISTS plesk_migrations (
  id                    varchar(36) PRIMARY KEY,
  source_id             varchar(36) NOT NULL REFERENCES plesk_sources(id) ON DELETE CASCADE,
  -- The discovery whose snapshot we provision from (NULL once that
  -- discovery is pruned — the frozen snapshot below is authoritative).
  discovery_id          varchar(36) REFERENCES plesk_discoveries(id) ON DELETE SET NULL,
  subscription_name     varchar(255) NOT NULL,
  -- Frozen PleskSubscription inventory at create-time (authoritative).
  subscription_snapshot jsonb NOT NULL,
  -- Operator-chosen target plan (hosting_plans.id). Plesk service plans
  -- don't map 1:1, so the operator picks.
  target_plan_id        varchar(36) NOT NULL REFERENCES hosting_plans(id),
  -- Contact email for the new tenant's admin user. NULL → defaults to
  -- admin@<subscription_name> at provision time.
  contact_email         varchar(320),
  -- Set once the tenant leg completes; SET NULL if the tenant is later
  -- deleted so the migration row survives as an audit trail.
  target_tenant_id      varchar(36) REFERENCES tenants(id) ON DELETE SET NULL,
  -- pending | running | completed | failed | partial
  status                varchar(16) NOT NULL DEFAULT 'pending',
  -- Per-leg state map: { tenant: {status,…}, domains: {…}, email: {…} }.
  legs                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  error                 text,
  created_by            varchar(36),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plesk_migrations_source_idx
  ON plesk_migrations (source_id, created_at DESC);

-- One in-flight migration per (source, subscription): a partial unique
-- index on the live statuses stops a double-click spawning two provision
-- runs for the same subscription (completed/failed rows don't collide, so
-- re-running after a failure is allowed).
CREATE UNIQUE INDEX IF NOT EXISTS plesk_migrations_active_uniq
  ON plesk_migrations (source_id, subscription_name)
  WHERE status IN ('pending', 'running');
