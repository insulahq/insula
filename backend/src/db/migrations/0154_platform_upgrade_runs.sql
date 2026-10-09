-- ADR-064: a platform upgrade is a recorded RUN in three steps —
--   prepare-nodes   every included node fetches + verifies the release's insula CLI
--                   and applies its before-services host changes (pushed through the
--                   system-upgrade-controller);
--   update-services the Flux re-pin (containers roll, platform migrations run);
--   finish          after-services host changes, then every node reports the target.
-- The Task Center task, the progress view and the run history read this row.
-- At most one run is in flight (partial unique index).
CREATE TABLE IF NOT EXISTS "platform_upgrade_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "from_version" text,
  "to_version" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'manual',
  "status" text NOT NULL DEFAULT 'running',
  "step" text NOT NULL DEFAULT 'prepare-nodes',
  -- Nodes the operator chose to upgrade without (offline at the start); they catch
  -- up through their own update timer when they return.
  "excluded_nodes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Last per-node view the run recorded: [{ node, state, cliVersion, detail }].
  "nodes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "message" text,
  "initiated_by" varchar(36) REFERENCES "users"("id") ON DELETE SET NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "step_started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  -- cancelled = an operator stopped it before the services changed; rolled-back =
  -- a rollback took over. Kept apart from failed so history shows real faults.
  CONSTRAINT "platform_upgrade_runs_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed', 'cancelled', 'rolled-back')),
  CONSTRAINT "platform_upgrade_runs_step_check" CHECK ("step" IN ('prepare-nodes', 'update-services', 'finish', 'done')),
  CONSTRAINT "platform_upgrade_runs_mode_check" CHECK ("mode" IN ('manual', 'auto'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "platform_upgrade_runs_one_running"
  ON "platform_upgrade_runs" ((true)) WHERE "status" = 'running';

CREATE INDEX IF NOT EXISTS "platform_upgrade_runs_started_at_idx"
  ON "platform_upgrade_runs" ("started_at" DESC);
