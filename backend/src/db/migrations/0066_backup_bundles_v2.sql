-- Migration 0066: component-oriented backup bundles (ADR-032 / ADR-028)
--
-- Adds three tables (backup_jobs, backup_components, client_backup_schedules)
-- and four columns on hosting_plans for plan-quota enforcement.
--
-- The legacy `backups` table is left intact and read-only; the client-panel
-- placeholder page still reads it. A future migration will drop it once the
-- panel is repointed at backup_jobs.
--
-- See:
--   docs/07-reference/ADR-032-backupstore-interface-and-bundle-orchestration.md
--   docs/06-features/BACKUP_COMPONENT_MODEL.md

-- ─── Plan-quota columns ────────────────────────────────────────────────────
ALTER TABLE hosting_plans
  ADD COLUMN default_backup_retention_days INT NOT NULL DEFAULT 30,
  ADD COLUMN max_backup_retention_days     INT NOT NULL DEFAULT 90,
  ADD COLUMN max_backups                   INT NOT NULL DEFAULT 10,
  ADD COLUMN max_backup_size_bytes         BIGINT NOT NULL DEFAULT 53687091200; -- 50 GiB

-- ─── Enums ─────────────────────────────────────────────────────────────────
CREATE TYPE backup_initiator AS ENUM ('client', 'admin', 'system', 'cluster');
CREATE TYPE backup_system_trigger AS ENUM ('pre_resize', 'pre_archive', 'scheduled', 'manual');
CREATE TYPE backup_job_status AS ENUM ('pending', 'running', 'completed', 'partial', 'failed', 'expired');
CREATE TYPE backup_component_name AS ENUM ('files', 'mailboxes', 'config', 'secrets');
CREATE TYPE backup_component_status AS ENUM ('pending', 'running', 'completed', 'skipped', 'failed');
CREATE TYPE backup_target_kind AS ENUM ('hostpath', 's3', 'ssh');
CREATE TYPE client_backup_schedule_freq AS ENUM ('daily', 'weekly', 'monthly');

-- ─── backup_jobs ───────────────────────────────────────────────────────────
-- One row per bundle. Source of truth for the admin/client backup list.
CREATE TABLE backup_jobs (
  id                 VARCHAR(36) PRIMARY KEY,
  client_id          VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  initiator          backup_initiator NOT NULL,
  system_trigger     backup_system_trigger,
  status             backup_job_status NOT NULL DEFAULT 'pending',

  -- Where the bundle lives. target_kind + target_uri uniquely identify the
  -- store; target_config_id is set when the target is the per-tenant
  -- backup_configurations row (S3 / SSH). For hostpath, target_config_id is null.
  target_kind        backup_target_kind NOT NULL,
  target_uri         VARCHAR(1000) NOT NULL,
  target_config_id   VARCHAR(36) REFERENCES backup_configurations(id) ON DELETE SET NULL,

  label              VARCHAR(255),
  description        TEXT,
  size_bytes         BIGINT NOT NULL DEFAULT 0,

  retention_days     INT NOT NULL,
  expires_at         TIMESTAMP,

  -- For the GDPR data-export wrapper. NULL = no wrapper.
  export_mode        VARCHAR(32),                  -- 'data_export' | NULL
  export_artifact    VARCHAR(1000),                -- final wrapped tarball path

  started_at         TIMESTAMP,
  finished_at        TIMESTAMP,
  last_error         TEXT,

  created_at         TIMESTAMP NOT NULL DEFAULT now(),
  updated_at         TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX backup_jobs_client_idx    ON backup_jobs(client_id);
CREATE INDEX backup_jobs_status_idx    ON backup_jobs(status);
CREATE INDEX backup_jobs_initiator_idx ON backup_jobs(initiator);
CREATE INDEX backup_jobs_expires_idx   ON backup_jobs(expires_at);

-- ─── backup_components ─────────────────────────────────────────────────────
-- One row per component-artifact. Lets the orchestrator retry a single
-- component without redoing the bundle. (See ADR-032 §6.)
CREATE TABLE backup_components (
  id           VARCHAR(36) PRIMARY KEY,
  backup_job_id VARCHAR(36) NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,

  component    backup_component_name NOT NULL,
  -- For mailboxes we keep one row per address. For files/config/secrets
  -- there is exactly one artifact (name='archive.tar.gz' / 'db-rows.json.gz' / 'tls.json.gz.enc').
  artifact_name VARCHAR(255) NOT NULL,

  status       backup_component_status NOT NULL DEFAULT 'pending',
  size_bytes   BIGINT NOT NULL DEFAULT 0,
  sha256       VARCHAR(64),

  started_at   TIMESTAMP,
  finished_at  TIMESTAMP,
  last_error   TEXT,

  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now(),

  UNIQUE (backup_job_id, component, artifact_name)
);

CREATE INDEX backup_components_job_idx    ON backup_components(backup_job_id);
CREATE INDEX backup_components_status_idx ON backup_components(status);

-- ─── client_backup_schedules ───────────────────────────────────────────────
-- Per-client schedule for the `client` initiator. One row per client.
-- retention_days is bounded by hosting_plans.max_backup_retention_days at
-- write time (enforced by the API, not the DB).
CREATE TABLE client_backup_schedules (
  client_id        VARCHAR(36) PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  frequency        client_backup_schedule_freq NOT NULL DEFAULT 'weekly',
  hour_of_day_utc  INT NOT NULL DEFAULT 3,         -- 0..23
  day_of_week      INT,                            -- 0..6, nullable except for weekly
  day_of_month     INT,                            -- 1..28, nullable except for monthly
  retention_days   INT NOT NULL DEFAULT 14,
  last_run_at      TIMESTAMP,
  last_run_status  backup_job_status,
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now()
);
