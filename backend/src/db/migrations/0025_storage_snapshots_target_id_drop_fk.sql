-- B4 fix (2026-05-22): drop the FK constraint on
-- storage_snapshots.target_id.
--
-- The shim-routing path in `snapshot-store.ts:resolveStreamingStore`
-- intentionally synthesises a target_id of the form `shim:<class>`
-- (e.g. `shim:tenant_snapshot`) when a snapshot streams through the
-- universal shim. There is no backup_configurations row for the shim
-- itself — it's a virtual upstream — so the synthetic sentinel is
-- correct as a forensic record but cannot satisfy the FK to
-- backup_configurations(id).
--
-- Empirically on staging: every operator click of "Take snapshot now"
-- on a tenant detail page fails with
--   FOREIGN_KEY_VIOLATION storage_snapshots_target_id_fkey:
--   Key (target_id)=(shim:tenant_snapshot) is not present in table
--   backup_configurations.
--
-- Dropping the FK lets the synthetic sentinel land. JOINS that resolve
-- target_id → backup_configurations.name continue to work for legacy
-- rows (real UUIDs); rows with `shim:<class>` simply LEFT-JOIN to NULL,
-- which is the correct rendering (the UI shows "via shim" instead of
-- a target name).

ALTER TABLE "storage_snapshots"
  DROP CONSTRAINT IF EXISTS "storage_snapshots_target_id_fkey";

-- Index stays so existing queries by target_id keep using it.

COMMENT ON COLUMN "storage_snapshots"."target_id" IS
  'Either a backup_configurations.id UUID (legacy direct-target snapshots) OR the sentinel `shim:<backup_class>` (snapshots that streamed through the universal backup-rclone-shim). No FK constraint since the sentinel does not have a backup_configurations row.';
