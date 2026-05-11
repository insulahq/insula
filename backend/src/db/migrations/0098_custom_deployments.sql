-- ADR-036: third deployment path (custom container/compose).
--
-- Adds the discriminator + spec column to the existing deployments
-- table, makes catalog_entry_id nullable for the new 'custom' source,
-- and introduces three sibling tables (image credentials / audit /
-- update-check cache) that hang off the deployment when source='custom'.
--
-- OPERATOR NOTE — LOCKING:
--   This file takes AccessExclusiveLock on the hot `deployments`
--   table FOUR times (ADD COLUMN x2, DROP NOT NULL, ADD CONSTRAINT).
--   PG11+ makes ADD COLUMN with a constant DEFAULT a metadata-only
--   change (fast), but the locks still queue all concurrent reads
--   and writes while held. On a busy CNPG primary the
--   status-reconciler hits this table every 60 s — a long lock
--   wait will stall API requests for the lock duration.
--
--   Run during a low-traffic window OR set a session lock_timeout
--   before applying this file:
--
--     psql ... -c "SET lock_timeout = '3s'; \i 0098_custom_deployments.sql"
--
--   With lock_timeout set, a blocked DDL fails fast (SQLSTATE 55P03)
--   and you retry rather than queueing behind a long transaction.
--
-- Storage policy:
--   * The token (PAT) is envelope-encrypted with the same
--     OIDC_ENCRYPTION_KEY + 'kid:' prefix used by oidc_settings and
--     client_mtls_providers. Cleartext is never logged and never
--     returned by the API.
--   * The image-audit trail captures the digest the kubelet actually
--     pulled (Pod.containerStatuses[].imageID), not just what the user
--     declared. Useful when a tenant pulled a mutable tag (:latest)
--     and we later need to know which sha they were running.
--   * The update-check cache is keyed on (image, registry, current_tag)
--     so two deployments running the same image share a single
--     registry probe. 60-min TTL is enforced in the application layer
--     (the row is kept but treated stale).

-- ─── New enum ───────────────────────────────────────────────────────────────

DO $$
BEGIN
  CREATE TYPE deployment_source AS ENUM ('catalog', 'custom');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- ─── Extend deployments ─────────────────────────────────────────────────────

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS source deployment_source NOT NULL DEFAULT 'catalog';

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS custom_spec jsonb;

-- catalog_entry_id was NOT NULL; custom rows have no catalog entry.
-- Idempotent: DROP NOT NULL is a no-op if it's already nullable.
ALTER TABLE deployments
  ALTER COLUMN catalog_entry_id DROP NOT NULL;

-- XOR constraint: exactly one of (catalog_entry_id, custom_spec) is
-- non-null, matching the source discriminator. Cheap insurance against
-- a bug elsewhere writing a half-formed row.
ALTER TABLE deployments
  DROP CONSTRAINT IF EXISTS deployments_source_xor;

ALTER TABLE deployments
  ADD CONSTRAINT deployments_source_xor CHECK (
    (source = 'catalog' AND catalog_entry_id IS NOT NULL AND custom_spec IS NULL)
    OR
    (source = 'custom'  AND catalog_entry_id IS NULL     AND custom_spec IS NOT NULL)
  );

-- Index for the admin-panel filter chip "show only custom" and for
-- the lifecycle hooks that need to fan-out custom-only behaviour.
CREATE INDEX IF NOT EXISTS deployments_source_idx ON deployments(source);

-- Convert the pre-existing `deployments_catalog_entry_idx` to a
-- partial index over non-NULL values only. After ADR-036 a growing
-- fraction of rows have catalog_entry_id IS NULL (source='custom'),
-- and indexing those NULLs is pure waste — no query filters by
-- `catalog_entry_id IS NULL` (the equivalent semantic is `source='custom'`,
-- which is served by deployments_source_idx above). Idempotent: the
-- DROP+CREATE pair is safe to re-run because both are guarded.
DROP INDEX IF EXISTS deployments_catalog_entry_idx;
CREATE INDEX IF NOT EXISTS deployments_catalog_entry_idx
  ON deployments(catalog_entry_id)
  WHERE catalog_entry_id IS NOT NULL;

-- ─── custom_deployment_image_credentials ────────────────────────────────────

CREATE TABLE IF NOT EXISTS custom_deployment_image_credentials (
  id varchar(36) PRIMARY KEY,
  deployment_id varchar(36) NOT NULL
    REFERENCES deployments(id) ON DELETE CASCADE,
  registry_host varchar(253) NOT NULL,
  username varchar(255) NOT NULL,
  -- Envelope-encrypted token. Format: 'kid:<key-id>:<ciphertext-b64>'.
  -- Cleartext is NEVER returned by the API.
  token_cipher text NOT NULL,
  -- Last 4 chars of the cleartext, for operator recognition only.
  token_last_four varchar(4) NOT NULL,
  -- timestamptz: NOW() returns timestamptz natively; storing as
  -- `timestamp` would silently truncate the offset under the session
  -- TimeZone GUC, breaking interpretations across CNPG replicas in
  -- different zones.
  created_at timestamptz NOT NULL DEFAULT NOW(),
  rotated_at timestamptz,
  CONSTRAINT custom_deployment_image_credentials_deployment_unique
    UNIQUE (deployment_id)
);

-- ─── custom_deployment_image_audit ──────────────────────────────────────────

-- DECISION (ADR-036 Phase 1): ON DELETE CASCADE destroys the
-- forensic audit trail when a deployment is hard-deleted. This is
-- intentional for Phase 1 — the client lifecycle's `deleted`
-- transition is the natural terminal state and the audit trail's
-- purpose is in-life forensics, not post-mortem. Phase 2 will add a
-- retention CronJob that copies recent audit rows to a long-term
-- store before a `deleted` cascade fires. If forensic data is
-- needed across deletions in Phase 1, an operator must snapshot the
-- table externally before triggering the delete.
CREATE TABLE IF NOT EXISTS custom_deployment_image_audit (
  id varchar(36) PRIMARY KEY,
  deployment_id varchar(36) NOT NULL
    REFERENCES deployments(id) ON DELETE CASCADE,
  image varchar(500) NOT NULL,
  -- name@sha256:<hex>, captured from kubelet once the pod pulls.
  resolved_digest varchar(256),
  -- timestamptz so the audit trail timestamps are unambiguous when
  -- viewed across operator locales (forensic data).
  pulled_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS custom_deployment_image_audit_deployment_idx
  ON custom_deployment_image_audit(deployment_id);

CREATE INDEX IF NOT EXISTS custom_deployment_image_audit_pulled_idx
  ON custom_deployment_image_audit(pulled_at);

-- One row per (deployment, digest). NULLS NOT DISTINCT (PG15+) means
-- there is AT MOST ONE NULL-digest row per deployment — the
-- "still pulling" sentinel. A second sentinel insertion for the same
-- deployment hits the constraint and is rejected (which the application
-- treats as an idempotent no-op). Without NULLS NOT DISTINCT, NULL
-- rows would accumulate unboundedly under rolling restarts.
-- Drizzle ORM does not yet expose .nullsNotDistinct() on uniqueIndex()
-- as of the version pinned here; the matching schema.ts uses
-- uniqueIndex(...) (DISTINCT NULLs) — the SQL constraint wins at the
-- database layer.
CREATE UNIQUE INDEX IF NOT EXISTS custom_deployment_image_audit_deployment_digest_unique
  ON custom_deployment_image_audit(deployment_id, resolved_digest)
  NULLS NOT DISTINCT;

-- Partial index for the sentinel-row lookup
-- (`WHERE deployment_id = $1 AND resolved_digest IS NULL`). The main
-- unique index above does index NULL rows but `IS NULL` predicates
-- aren't covered by the (deployment_id, resolved_digest) leaf order;
-- this partial gives the resolver an O(log n) path.
CREATE INDEX IF NOT EXISTS custom_deployment_image_audit_pending_idx
  ON custom_deployment_image_audit(deployment_id)
  WHERE resolved_digest IS NULL;

-- ─── custom_deployment_image_check_cache ────────────────────────────────────

CREATE TABLE IF NOT EXISTS custom_deployment_image_check_cache (
  id varchar(36) PRIMARY KEY,
  image_reference varchar(500) NOT NULL,
  registry_host varchar(253) NOT NULL,
  current_tag varchar(128) NOT NULL,
  latest_tag varchar(128),
  -- Severity strings the application writes. Stored as varchar (not
  -- enum) so adding a new severity is a one-line CHECK migration, not
  -- a CREATE TYPE + USING-cast dance.
  severity varchar(16) NOT NULL,
  reason text,
  -- timestamptz: drives the 60-min TTL comparison
  -- `checked_at > now() - interval '60 minutes'`. Timezone-naive
  -- would break the comparison if the CNPG pod's TimeZone GUC
  -- drifted off UTC.
  checked_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT custom_deployment_image_check_cache_key_unique
    UNIQUE (image_reference, registry_host, current_tag),
  CONSTRAINT custom_deployment_image_check_cache_severity_check
    CHECK (severity IN ('no-update', 'patch', 'minor', 'major', 'unknown'))
);

CREATE INDEX IF NOT EXISTS custom_deployment_image_check_cache_checked_idx
  ON custom_deployment_image_check_cache(checked_at);
