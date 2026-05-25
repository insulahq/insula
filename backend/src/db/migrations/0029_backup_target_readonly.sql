-- DR safety flag: read-only targets refuse every platform-driven write
-- or delete (tenant bundle create + retention, mail-restic snapshot +
-- forget, Longhorn snapshot upload + retention, speedtest, CNPG WAL
-- archive via cluster-level suspension). CNPG handling is special-cased
-- in backend/src/modules/cnpg-backup-now/wal-suspend.ts because
-- archiving cannot be cleanly blocked at the shim layer without
-- backpressure-stalling the cluster.
--
-- Set to true by the DR restore path on every target it imports from a
-- bundle, so a freshly restored cluster never overwrites or prunes the
-- existing repo until the operator explicitly marks the target R/W via
-- the admin UI (POST /admin/backup-configs/:id/mark-writable).
--
-- Default false: existing rows remain writable. No operational change
-- on upgrade.
ALTER TABLE backup_configurations
  ADD COLUMN read_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN backup_configurations.read_only IS
  'When true, all platform-driven writes/deletes against this target are refused with TARGET_FROZEN. Set by DR restore; cleared via /admin/backup-configs/:id/mark-writable after the operator confirms data integrity.';
