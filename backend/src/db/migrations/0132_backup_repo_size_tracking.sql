-- Repo size that maintains itself, and a per-bundle figure that explains it.
--
-- The admin Backups page had two numbers for "how much storage does this
-- tenant use", and both were wrong for the question asked:
--
--   SUM(backup_jobs.size_bytes)  the LOGICAL size of every bundle. A nightly
--                                bundle re-states the tenant's whole
--                                footprint, so 26 nightlies of a 15 GB tenant
--                                summed to 452 GB. Shown as "bundles <size>",
--                                it read as off-site storage filling up fast.
--
--   tenant_restic_repo_state.repo_total_bytes
--                                the honest number, from
--                                `restic stats --mode raw-data` — but only
--                                ever written by an operator pressing
--                                Refresh. On production 23 of 25 tenants had
--                                never been measured, so the honest column
--                                said "not measured" while the misleading one
--                                said 452 GB.
--
-- restic already prints what is needed. Every `restic backup --json` summary
-- carries `data_added_packed`: the bytes that snapshot actually added to the
-- repository, after dedup and compression. Measured on restic 0.18.1, summing
-- it across snapshots tracks `stats --mode raw-data` to 0.011%. The backend
-- was parsing that exact JSON object for `snapshot_id` and discarding the
-- rest.
--
-- So:
--   backup_jobs.restic_added_bytes   per bundle — surfaced as "Restic Size"
--                                    next to "Bundle Size", so the repo total
--                                    is explained by the rows on screen.
--   repo_total_source / repo_total_at
--                                    provenance for the accumulated total, so
--                                    the UI can distinguish "measured just
--                                    now" from "tracked since a measurement
--                                    four days ago" without either timestamp
--                                    having to lie.
--
-- All three are NULLABLE with no backfill, on purpose. NULL means "unknown",
-- and for these columns that is the truth: no bundle captured before this
-- migration reported a figure, and inventing 0 would make an unmeasured
-- tenant indistinguishable from one that genuinely added nothing. The
-- reclamation sweep seeds every unmeasured repo with a real measurement and
-- re-anchors after each prune, so the NULLs resolve on their own.

ALTER TABLE backup_jobs
  ADD COLUMN IF NOT EXISTS restic_added_bytes bigint;

ALTER TABLE tenant_restic_repo_state
  ADD COLUMN IF NOT EXISTS repo_total_source varchar(16);

ALTER TABLE tenant_restic_repo_state
  ADD COLUMN IF NOT EXISTS repo_total_at timestamp;

-- Rows that already carry a measured total predate the accumulator: label
-- them for what they are, and seed repo_total_at from the measurement that
-- produced them. Rows with no total stay fully NULL.
UPDATE tenant_restic_repo_state
   SET repo_total_source = 'measured',
       repo_total_at = repo_stats_at
 WHERE repo_total_bytes IS NOT NULL
   AND repo_total_source IS NULL;
