-- Collapse system snapshot classes into one + rename.
--
-- Phase 2 introduced three system classes (`system_snapshot`,
-- `system_etcd`, `system_secrets`) on the assumption that operators
-- would want to route them to different targets. In practice everything
-- "system" goes to the same place — splitting them was YAGNI. This
-- migration:
--
--   1. Drops the old CHECK constraints
--   2. Deletes any rows tagged with the retired classes
--      (`system_etcd`, `system_secrets`) — operator decision: no
--      backfill, those subsystems will simply re-snapshot under
--      `system_backup` on the next scheduled run.
--   3. Renames `system_snapshot` rows to `system_backup`
--   4. Re-adds CHECK constraints with the new 3-value enum
--
-- The `subsystem` column (free-form varchar) is untouched — a snapshot
-- from the etcd subsystem still has `subsystem='system-etcd'`, just
-- under the unified `system_backup` class.

-- ─── storage_snapshots ──────────────────────────────────────────────────

ALTER TABLE "storage_snapshots"
  DROP CONSTRAINT IF EXISTS "storage_snapshots_snapshot_class_check";

DELETE FROM "storage_snapshots"
  WHERE "snapshot_class" IN ('system_etcd', 'system_secrets');

UPDATE "storage_snapshots"
  SET "snapshot_class" = 'system_backup'
  WHERE "snapshot_class" = 'system_snapshot';

ALTER TABLE "storage_snapshots"
  ADD CONSTRAINT "storage_snapshots_snapshot_class_check"
  CHECK ("snapshot_class" IN (
    'tenant_snapshot',
    'tenant_bundle',
    'system_backup'
  ));

-- ─── backup_target_assignments ──────────────────────────────────────────

ALTER TABLE "backup_target_assignments"
  DROP CONSTRAINT IF EXISTS "backup_target_assignments_snapshot_class_check";

DELETE FROM "backup_target_assignments"
  WHERE "snapshot_class" IN ('system_etcd', 'system_secrets');

UPDATE "backup_target_assignments"
  SET "snapshot_class" = 'system_backup'
  WHERE "snapshot_class" = 'system_snapshot';

ALTER TABLE "backup_target_assignments"
  ADD CONSTRAINT "backup_target_assignments_snapshot_class_check"
  CHECK ("snapshot_class" IN (
    'tenant_snapshot',
    'tenant_bundle',
    'system_backup'
  ));
