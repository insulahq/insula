-- Database backup status: one row per tenant database, its last backup attempt
-- and its last good one.
--
-- Each nightly bundle took a logical dump of every tenant database and wrote
-- the per-database outcome into backup_jobs.database_dumps — on the bundle,
-- where nothing read it again. A tenant's seven MariaDB databases failed to dump
-- on every retained night for at least two weeks, the bundle said `completed`
-- every time, and nobody was told. These rows are what the stale-backup alert
-- and both panels read.
--
--   subject_key    the deployment id for a catalog database deployment;
--                  'sqlite' for SQLite files found on the tenant volume
--   database_name  the database, the SQLite file's path, or a synthetic name
--                  ('(deployment)', '(SQLite discovery)') when the dump could
--                  not even list the databases
--   stale_since    set by the sweep when no good backup is newer than the
--                  schedule allows; cleared on recovery
--   alerted_at     when the admin alert for this episode went out; a recovery
--                  notice is sent only for an episode that alerted
--
-- One row per database, pruned when the database is gone, so the table is
-- bounded by the number of tenant databases.
--
-- Additive: the previous release's API pods never read or write it.
--
-- Replay-safe (IF NOT EXISTS) for the non-transactional runner.

CREATE TABLE IF NOT EXISTS database_backup_status (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_key varchar(64) NOT NULL,
  database_name text NOT NULL,
  deployment_id varchar(36),
  deployment_name varchar(255) NOT NULL,
  engine varchar(32),
  last_attempt_at timestamptz NOT NULL,
  last_attempt_bundle_id varchar(64) NOT NULL,
  last_status varchar(16) NOT NULL CHECK (last_status IN ('dumped', 'degraded', 'failed')),
  last_error text,
  last_success_at timestamptz,
  last_success_bundle_id varchar(64),
  last_success_size_bytes bigint,
  stale_since timestamptz,
  alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_key, database_name)
);

CREATE INDEX IF NOT EXISTS database_backup_status_stale_idx
  ON database_backup_status (stale_since)
  WHERE stale_since IS NOT NULL;
