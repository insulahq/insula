-- Restart-safe eager image reaping (2026-08-04).
--
-- The eager reaper held its 5-minute grace period in an in-process
-- `setTimeout` inside platform-api. Nothing persisted it, so ANY restart in
-- that window — a deploy, a Flux reconcile, an OOM kill, a node drain — dropped
-- the reap SILENTLY: no image_reap_log row, no retry, no trace. The image then
-- sat on the node until the pressure watcher reclaimed it under disk pressure,
-- which is exactly what eager reaping exists to avoid.
--
-- Observed on the DEV cluster, which auto-deploys every push to `development`:
-- a deployment deleted at 13:43:44 armed a timer for 13:48:44; Flux rolled
-- platform-api and the replacement pod came up at 13:49:28. The reap never ran
-- and left no record — the only evidence was an absent log row.
--
-- This table makes the pending reap durable. A scheduler claims due rows with
-- DELETE ... RETURNING (atomic across replicas — the row goes to exactly one
-- worker) and re-inserts with a backoff if the reap fails, so the work survives
-- restarts and cannot be double-executed.
CREATE TABLE IF NOT EXISTS "pending_image_reaps" (
  "id"           bigserial PRIMARY KEY,
  "image_name"   text NOT NULL,
  "triggered_by" text NOT NULL,
  "trigger_ref"  text,
  -- When the grace period expires and the reap becomes eligible to run.
  "due_at"       timestamptz NOT NULL,
  "attempts"     integer NOT NULL DEFAULT 0,
  "last_error"   text,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

-- The scheduler's only query shape: "everything due now, oldest first".
CREATE INDEX IF NOT EXISTS "pending_image_reaps_due_at_idx"
  ON "pending_image_reaps" ("due_at");
