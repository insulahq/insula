-- Rename the routing column `snapshot_class` → `backup_class` on both
-- `storage_snapshots` and `backup_target_assignments`. The column name
-- pre-dates the universal backup-rclone-shim model; what we actually
-- store is a "backup class" routing key, not a snapshot-internal
-- attribute. The rename brings the SQL column name in line with the
-- domain language used everywhere else (CLAUDE.md, RFCs, operator UI).
--
-- target_id stays as-is (operator preference — see chat 2026-05-21).
--
-- The two CHECK constraints that whitelist the legacy enum values keep
-- the same semantics; we rename them to match the new column name so
-- a future operator running `\d backup_target_assignments` doesn't see
-- "snapshot_class_check" referring to a "backup_class" column.
--
-- Indexes are NOT renamed:
--   - storage_snapshots_class_idx: "class" is already generic enough.
--   - backup_target_assignments_class_priority_idx: same.
--
-- Drizzle migrations are wrapped in BEGIN/COMMIT by migrate.ts, so the
-- column rename + constraint rename either all apply or none do.

ALTER TABLE "storage_snapshots"
  RENAME COLUMN "snapshot_class" TO "backup_class";

ALTER TABLE "backup_target_assignments"
  RENAME COLUMN "snapshot_class" TO "backup_class";

ALTER TABLE "storage_snapshots"
  RENAME CONSTRAINT "storage_snapshots_snapshot_class_check"
  TO "storage_snapshots_backup_class_check";

ALTER TABLE "backup_target_assignments"
  RENAME CONSTRAINT "backup_target_assignments_snapshot_class_check"
  TO "backup_target_assignments_backup_class_check";
