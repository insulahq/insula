-- True per-tenant restic repository size, measured on demand.
--
-- `tenant_restic_repo_state.last_repo_size_bytes` is named as though it were
-- the repository's size. It is not: it stores the bytes PROCESSED by the most
-- recent snapshot run. For an incremental backup that is a small fraction of
-- the repo — a production tenant with roughly 6 GB of files reports 176 MiB
-- there — so presenting it as "repo size" in the admin UI would be wrong in a
-- way an operator cannot detect by looking.
--
-- Summing bundle sizes is wrong in the other direction: restic deduplicates
-- across snapshots, so the logical total overstates the storage consumed.
--
-- The only honest answer comes from `restic stats --mode raw-data` against the
-- repository itself. That walks the repo index, so it is a button, not a
-- page-load computation — these columns cache the result.
--
-- NULL means "never measured", which the UI shows as such rather than 0.
ALTER TABLE tenant_restic_repo_state
  ADD COLUMN IF NOT EXISTS repo_total_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS repo_stats_at TIMESTAMP;
