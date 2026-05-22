-- B5 fix (2026-05-22) — separate "last fired" from "last operator edit"
-- on backup_schedules.
--
-- The global tenant-bundle scheduler used `updated_at` as a proxy for
-- "last time this row fired", which had two failure modes:
--
--   1. Any operator PATCH (editing cron / retention / toggling
--      enabled) bumps updated_at, resetting the "already fired today"
--      check — the next eligible window would fire a duplicate wave.
--
--   2. When the platform-api pod is restarted between cron windows
--      (every Flux roll), the scheduler's ±5-min tick window is
--      easily missed entirely, and `updated_at` (which only changes
--      on operator edit) was never bumped, so the scheduler would
--      believe "never fired" forever and still not fire if the next
--      tick was outside the window.
--
-- This migration adds an explicit `last_fired_at` column. The
-- scheduler stores the actual fire timestamp here on every successful
-- wave (independent of updated_at). The shouldFireNow check uses
-- last_fired_at as the dedup key.
--
-- NULL = scheduler has never fired this row (or row was just created).

ALTER TABLE "backup_schedules"
  ADD COLUMN "last_fired_at" timestamp with time zone;

COMMENT ON COLUMN "backup_schedules"."last_fired_at" IS
  'Timestamp of the most recent successful scheduler wave for this subsystem. Set by the global scheduler when it dispatches a fire. NULL until the first fire. Distinct from updated_at, which tracks operator edits.';
