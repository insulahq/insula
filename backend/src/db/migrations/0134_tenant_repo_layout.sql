-- Record which restic repository layout each bundle was written to (ADR-061).
--
-- Tenant snapshots have lived in two repositories per tenant —
-- `restic-files/<tenantId>` and `restic-mailboxes/<tenantId>` — since each
-- component was migrated to restic separately. The split is sediment, not a
-- boundary: `deriveResticPassword` puts no component in its HKDF info string,
-- so one password already opens both, and the shim's S3 credentials are
-- bucket-root regardless. Merging them into `restic/<tenantId>` gives one
-- repository to key for DR, one retention sweep, one repo-size figure, and a
-- uniform export.
--
-- The merge moves NO DATA. New bundles are written to the merged repository;
-- every existing bundle stays exactly where it is and is read from there until
-- it expires under normal retention. This column is how a reader knows which:
--
--   NULL / 'per-component'  restic-files/<id> + restic-mailboxes/<id>
--   'per-tenant'            restic/<id>
--
-- NULL is the historical layout on purpose, so no backfill is required and a
-- row written before this migration resolves correctly. That matters more than
-- it looks: restic does not error when pointed at a repository that lacks a
-- snapshot, it reports the snapshot as absent — so a wrong layout surfaces to
-- an operator as "the backup is gone" rather than as a failure.
--
-- meta.json carries the same value (`repoLayout`), because a cross-cluster
-- import or a DR re-create has the storage target but not this database.
ALTER TABLE backup_jobs
  ADD COLUMN IF NOT EXISTS repo_layout VARCHAR(16);

COMMENT ON COLUMN backup_jobs.repo_layout IS
  'ADR-061 restic repository layout: NULL/per-component = restic-<component>/<tenantId>; per-tenant = restic/<tenantId>. NULL is the pre-merge layout.';
