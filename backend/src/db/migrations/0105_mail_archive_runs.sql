-- Stalwart-native, app-level archive runs (operator-triggered).
--
-- Distinct from the continuous restic backup CronJob (mail_snapshot_*).
-- An archive run scales the Stalwart Deployment to 0, releases the
-- RocksDB LOCK, runs `stalwart -e` against the data dir, uploads the
-- LZ4 export via restic, then scales back to the original replica
-- count. Mail SMTP/IMAP is unavailable for the duration (~60-120s
-- typical on a small DataStore).
--
-- Each run has a state machine:
--   queued        — row inserted; orchestrator hasn't started yet
--   scaling_down  — patching Deployment replicas to 0 + waiting for pod terminate
--   exporting     — one-shot Job is running stalwart -e + restic upload
--   scaling_up    — restoring original replicas + waiting for Ready
--   succeeded     — completed; restic_snapshot_id + size are set
--   failed        — error_message is set; we tried to restore replicas anyway
--
-- The orchestrator (backend/src/modules/mail-admin/archive.ts) lives in
-- platform-api; the export+upload work is delegated to a one-shot k8s
-- Job (stalwart-archive-*) so the long-running shell pipeline doesn't
-- block the API process.
CREATE TABLE IF NOT EXISTS mail_archive_runs (
  id varchar(36) PRIMARY KEY,
  state varchar(32) NOT NULL DEFAULT 'queued',
  current_step varchar(64),
  -- Snapshot of replicas BEFORE the run started, so we always
  -- restore to the same shape regardless of mid-run config changes.
  original_replicas integer NOT NULL,
  job_name varchar(253),
  -- restic snapshot ID after successful upload (8 hex chars).
  restic_snapshot_id varchar(64),
  -- LZ4 export size in bytes (raw export, before restic dedupe).
  export_size_bytes bigint,
  -- restic snapshot's "Added to the repository" delta.
  restic_added_bytes bigint,
  triggered_by varchar(64) NOT NULL DEFAULT 'operator',
  triggered_by_user_id varchar(36),
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS mail_archive_runs_state_idx
  ON mail_archive_runs(state) WHERE state IN ('queued', 'scaling_down', 'exporting', 'scaling_up');

CREATE INDEX IF NOT EXISTS mail_archive_runs_started_at_idx
  ON mail_archive_runs(started_at DESC);
