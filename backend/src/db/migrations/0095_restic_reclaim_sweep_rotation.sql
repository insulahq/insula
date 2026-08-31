-- Round-robin coverage for the restic reclamation sweep.
--
-- The sweep processes a bounded number of repositories per tick and ordered
-- candidates by `last_forget_at ASC NULLS FIRST`. But a reclaim-state row was
-- only written when a repository actually had something forgotten — a repo that
-- was skipped (nothing to forget, repository unreachable) got no row at all, so
-- it kept sorting into the NULLS-FIRST group on every subsequent tick.
--
-- With more repositories than the per-tick cap, that starves the tail: which
-- repos get examined depends on Postgres's arbitrary tie-break among equal NULL
-- keys rather than on when each was last looked at. Measured on staging: 131
-- repository pairs, only 21 ever recorded, and four consecutive sweeps stopped
-- making progress while ~110 pairs had never been examined.
--
-- `last_sweep_at` is stamped for EVERY repository the sweep examines, whatever
-- the outcome, and drives the ordering. That makes coverage a true round robin:
-- the least-recently-examined repositories are always next.
ALTER TABLE restic_repo_reclaim_state
  ADD COLUMN IF NOT EXISTS last_sweep_at TIMESTAMP,
  -- Why the repo was skipped last time, for operator visibility into a sweep
  -- that reports large skip counts.
  ADD COLUMN IF NOT EXISTS last_sweep_outcome VARCHAR(32);

CREATE INDEX IF NOT EXISTS restic_repo_reclaim_state_last_sweep_idx
  ON restic_repo_reclaim_state (last_sweep_at);
