-- migration 0028 — create mail_migration_runs table.
--
-- Discovered missing during the 2026-05-25 A4 destructive auto-failover
-- test on staging: the dr-watcher's triggerRestoreBasedFailover insists
-- on inserting an audit row into `mail_migration_runs` BEFORE running
-- the state machine, but no migration file in the tree ever created the
-- table. Every dr-watcher trigger failed with "relation does not exist"
-- and the failover never advanced.
--
-- Schema reconstructed from the column references in
-- backend/src/modules/mail-admin/migration.ts:
--   - id (uuid, PK)            — randomUUID() per run
--   - source_node (varchar)    — where mail was running pre-migration
--   - target_node (varchar)    — where the migration ends up
--   - state (varchar)          — queued | running | done | failed
--   - current_step (varchar)   — preflight | snapshotting | swapping-pvc |
--                                recreating-pvc | applying-affinity |
--                                scaling-up | verifying | complete
--   - progress_bytes (bigint)  — optional progress indicator
--   - triggered_by (varchar)   — 'operator' | 'dr-watcher'
--   - started_at (timestamptz) — now() default
--   - finished_at (timestamptz)— null until done/failed
--   - error_message (text)     — populated when state='failed'
--
-- IF NOT EXISTS — operators who pre-created the table during the
-- 2026-05-25 incident (via psql) won't trip this migration.

-- NOTE on `id`: VARCHAR(36) (matches the codebase's randomUUID() shape)
-- rather than native UUID. Stays consistent with the rest of the
-- platform schema (varchar PKs are the established convention here);
-- migration to native UUID is deferred to a separate cross-table
-- normalisation effort.
CREATE TABLE IF NOT EXISTS mail_migration_runs (
  id              VARCHAR(36) PRIMARY KEY,
  source_node     VARCHAR(253) NOT NULL,
  target_node     VARCHAR(253) NOT NULL,
  state           VARCHAR(64)  NOT NULL,
  current_step    VARCHAR(64),
  progress_bytes  BIGINT,
  -- Always populated by both call-sites in migration.ts
  -- ('operator' or 'dr-watcher'). Enforce at the DB layer so a
  -- future code path can't slip in NULL.
  triggered_by    VARCHAR(64) NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  error_message   TEXT,
  -- Restrict `state` to the values used by the state machine. A
  -- CHECK is enough; pgEnum would force a code-review every time
  -- the migration state machine introduces a new state.
  CONSTRAINT mail_migration_runs_state_chk
    CHECK (state IN ('queued', 'running', 'done', 'failed'))
);

CREATE INDEX IF NOT EXISTS mail_migration_runs_started_at_idx
  ON mail_migration_runs (started_at DESC);
