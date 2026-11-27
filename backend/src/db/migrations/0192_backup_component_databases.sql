-- backup_components.component: per-database restic snapshots (phase 4 of the
-- database backup work). One row per database, artifact
-- `<deploymentId>:<database>`, sha256 = the snapshot id.
--
-- ADD VALUE IF NOT EXISTS is replay-safe; the runner applies it outside a
-- transaction.

ALTER TYPE backup_component_name ADD VALUE IF NOT EXISTS 'databases';
