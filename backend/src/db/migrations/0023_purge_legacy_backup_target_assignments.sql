-- Phase 2 legacy purge (2026-05-22): delete the 4 legacy snapshot-class
-- routing rows from backup_target_assignments. The pre-R-X model had
-- 7 routing classes; the universal backup-rclone-shim collapsed
-- routing into 3 classes (system / tenant / mail) and the 4 legacy
-- rows have been redundant ever since R-X8 took over.
--
-- After this migration, only the 3 shim classes remain valid routing
-- keys in backup_target_assignments. The CHECK constraint on the
-- column is narrowed to match, so a future operator can't accidentally
-- reintroduce a legacy row.
--
-- `storage_snapshots.backup_class` is NOT touched — the 4 legacy
-- values remain valid CATEGORY labels on existing snapshot rows
-- (`tenant_snapshot` continues to mean "a Longhorn PVC snapshot",
-- distinct from `system_backup` etc.). The `target-resolver.ts`
-- module translates these category labels into the corresponding
-- shim routing class at lookup time, so existing snapshots route
-- correctly under the new model.
--
-- Code changes that ship with this migration:
--   * backend/src/modules/storage-lifecycle/target-resolver.ts adds
--     a 1:1 shimRoutingClassFor() translation
--   * backend/src/modules/backup-schedules/service.ts GATE_MAP
--     re-mapped (mail→mail, tenant_bundle→tenant, system_pitr→system)
--   * backend/src/modules/backups-overview/service.ts gatedClassFor
--     mirrors the GATE_MAP change
--   * backend/src/modules/storage-lifecycle/backfill.ts now reads the
--     `tenant` shim class instead of `tenant_snapshot`
--   * backend/src/modules/mail-admin/snapshot-settings.ts reads /
--     writes the `mail` shim class directly (no more legacy sync)
--   * Deleted: backend/src/modules/snapshot-classes/ (entire module)
--   * Deleted: backend/src/modules/mail-admin/mail-target-{sync,
--     scheduler}.ts (mail-restic-shim reconciler handles it)
--
-- Reversibility: if the CHECK narrowing causes unexpected operator
-- breakage, manually re-widen via:
--   ALTER TABLE backup_target_assignments
--     DROP CONSTRAINT backup_target_assignments_backup_class_check;
--   ALTER TABLE backup_target_assignments
--     ADD CONSTRAINT backup_target_assignments_backup_class_check
--     CHECK (backup_class IN
--       ('tenant_snapshot','tenant_bundle','system_backup','system_mail',
--        'system','tenant','mail'));
-- The deleted rows can be re-inserted manually with their target_id.

-- Step 1: delete legacy rows. NOOP on fresh installs (no such rows yet).
DELETE FROM "backup_target_assignments"
 WHERE "backup_class" IN (
   'tenant_snapshot',
   'tenant_bundle',
   'system_backup',
   'system_mail'
 );

-- Step 2: narrow the CHECK constraint to the 3 shim classes.
ALTER TABLE "backup_target_assignments"
  DROP CONSTRAINT IF EXISTS "backup_target_assignments_backup_class_check";

ALTER TABLE "backup_target_assignments"
  ADD CONSTRAINT "backup_target_assignments_backup_class_check"
  CHECK ("backup_class" IN (
    'system',
    'tenant',
    'mail'
  ));
