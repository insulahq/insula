-- Freshness verdict memory for watched backup schedules.
--
-- Two jobs, both of which need to survive a restart:
--
--   1. `verdict` is fed back into evaluateFreshness() as `previous`. That is
--      the entire hysteresis mechanism — between one missed fire and the
--      three-miss threshold the verdict HOLDS rather than flipping. Without
--      persistence every tick starts from 'fresh' and a schedule whose runs
--      land either side of the boundary oscillates fresh->stale->fresh. An
--      alert that flaps is an alert that gets muted.
--   2. `notified_verdict` records what the operator was actually TOLD, so a
--      condition that is still true is not re-sent every five minutes.
--
-- Bounded by construction: one row per watched CronJob, and the sweep deletes
-- rows whose UID it did not see, so deleting a schedule does not leave a row
-- behind for the life of the cluster.
--
-- Replay-safe; the runner is not transactional.
CREATE TABLE IF NOT EXISTS backup_freshness_state (
  resource_uid      varchar(64) PRIMARY KEY,
  namespace         varchar(253) NOT NULL,
  name              varchar(253) NOT NULL,
  verdict           varchar(16)  NOT NULL,
  missed_fires      integer      NOT NULL DEFAULT 0,
  last_success_at   timestamptz,
  notified_verdict  varchar(16),
  evaluated_at      timestamptz  NOT NULL DEFAULT NOW()
);
