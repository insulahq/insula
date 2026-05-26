-- migration 0031 — create mail_archive_runs table.
--
-- Discovered missing during the 2026-05-26 audit of the Email →
-- Operations → Backups tab on staging:
--
--   /api/v1/admin/mail/archive-status was returning 503 because
--   `SELECT * FROM mail_archive_runs ...` threw with:
--     "relation \"mail_archive_runs\" does not exist"
--
--   The `mail_archive_schedule_*` columns on system_settings DO exist
--   (added by migration 0000 baseline), but the actual per-run audit
--   table that backend/src/modules/mail-admin/archive.ts writes
--   INSERT/UPDATE statements against was never created by any
--   migration in the tree.
--
-- Schema reconstructed from the column references in archive.ts:
--   - id (varchar(36) PK)        — randomUUID() per run
--   - state (varchar)            — queued | exporting | scaling_down |
--                                  scaling_up | succeeded | failed
--   - current_step (varchar)     — free-form per-orchestrator step label
--   - mode (varchar)             — 'no_downtime' (RocksDB checkpoint
--                                  via secondary instance) | 'downtime'
--                                  (scale-to-0 + stalwart -e/-i)
--   - original_replicas (int)    — captured pre-scale so the orchestrator
--                                  can scale back to the right number
--   - job_name (varchar)         — k8s Job created for the export/restore
--   - restic_snapshot_id (varchar) — populated on success of an export run;
--                                  required to start a restore
--   - export_size_bytes (bigint) — LZ4 export size on disk
--   - restic_added_bytes (bigint) — restic added-to-repo bytes
--   - triggered_by (varchar)     — 'operator' | 'archive-scheduler' | 'restore'
--   - triggered_by_user_id (varchar(36)) — null for scheduler-triggered
--   - error_message (text)       — populated when state='failed'
--   - started_at (timestamptz)   — now() default
--   - finished_at (timestamptz)  — null until done/failed
--
-- IF NOT EXISTS — operators who pre-created the table during the
-- 2026-05-26 incident (via psql) won't trip this migration.

CREATE TABLE IF NOT EXISTS mail_archive_runs (
  id                    varchar(36) PRIMARY KEY,
  state                 varchar(32) NOT NULL DEFAULT 'queued',
  current_step          varchar(64),
  mode                  varchar(16) NOT NULL DEFAULT 'no_downtime',
  original_replicas     integer NOT NULL DEFAULT 1,
  job_name              varchar(253),
  restic_snapshot_id    varchar(64),
  export_size_bytes     bigint,
  restic_added_bytes    bigint,
  triggered_by          varchar(32) NOT NULL DEFAULT 'operator',
  triggered_by_user_id  varchar(36),
  error_message         text,
  started_at            timestamp with time zone NOT NULL DEFAULT now(),
  finished_at           timestamp with time zone,
  CONSTRAINT mail_archive_runs_state_chk CHECK (
    state IN (
      'queued','exporting','scaling_down','scaling_up','succeeded','failed'
    )
  ),
  CONSTRAINT mail_archive_runs_mode_chk CHECK (
    mode IN ('no_downtime','downtime')
  ),
  CONSTRAINT mail_archive_runs_triggered_by_chk CHECK (
    triggered_by IN ('operator','archive-scheduler','restore')
  )
);

-- Index: the archive-status query reads the latest succeeded/failed
-- row per cluster. ORDER BY started_at DESC LIMIT 1 wants an index
-- over started_at scoped by state.
CREATE INDEX IF NOT EXISTS idx_mail_archive_runs_state_started
  ON mail_archive_runs (state, started_at DESC);

-- Index: list pagination orders by started_at DESC.
CREATE INDEX IF NOT EXISTS idx_mail_archive_runs_started_at
  ON mail_archive_runs (started_at DESC);

COMMENT ON TABLE mail_archive_runs IS
  'Per-run audit + state machine for Stalwart -e/-i archive runs. Driven by backend/src/modules/mail-admin/archive.ts.';
