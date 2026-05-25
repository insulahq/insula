-- migration 0026 — drop NFS backup-target support entirely.
--
-- Background: migration 0015 added `nfs` to the storage_type enum and
-- the four nfs_* columns on backup_configurations. The design was for
-- the rclone-shim DaemonSet to kernel-mount the export via Pod
-- `volumes[].nfs` and let rclone treat it as `type=local` (see
-- ADR-043).
--
-- That path was abandoned at R-X19 (2026-05-21) when the shim went
-- fully unprivileged (runAsUser:65534, drop:[ALL]). rclone has no
-- native NFS *client* backend, and kernel-mounting NFS would require
-- CAP_SYS_ADMIN on the shim pod, undoing the R-X19 hardening. The
-- renderer has been hard-rejecting `nfs` rows ever since.
--
-- This migration removes the schema artifacts so the DB no longer
-- claims to support a storage_type the application refuses to render.
-- Operators using NFS on their storage server should run that NFS
-- export through an SMB gateway or upload via SFTP/S3; the platform's
-- price-band operators almost universally have at least one of those
-- on top of NFS.
--
-- Safety: this migration refuses to run if any backup_configurations
-- row still carries storage_type='nfs'. Operators who have such rows
-- must DELETE them (or migrate them to a supported type) before
-- bootstrap.sh can apply this migration.

-- ─── Safety guard ───────────────────────────────────────────────────
DO $$
DECLARE
  cnt INTEGER;
BEGIN
  SELECT count(*) INTO cnt
  FROM backup_configurations
  WHERE "storageType"::text = 'nfs';
  IF cnt > 0 THEN
    RAISE EXCEPTION 'Cannot drop nfs storage_type: % backup_configurations row(s) still use it. Migrate them to s3/ssh/cifs (or DELETE them) before re-running migrations.', cnt;
  END IF;
END $$;

-- ─── Drop CHECK + columns ───────────────────────────────────────────
ALTER TABLE backup_configurations
  DROP CONSTRAINT IF EXISTS backup_configurations_nfs_required;

ALTER TABLE backup_configurations
  DROP COLUMN IF EXISTS nfs_server,
  DROP COLUMN IF EXISTS nfs_export,
  DROP COLUMN IF EXISTS nfs_version,
  DROP COLUMN IF EXISTS nfs_options;

-- ─── Narrow the enum (rename-dance, idempotent) ────────────────────
-- PostgreSQL cannot remove an enum value in-place; the canonical
-- pattern is rename → create new without the value → ALTER column to
-- the new type → drop the old one.
--
-- The migration runner (backend/src/db/migrate.ts) executes each
-- split statement on a fresh connection, so plain BEGIN/COMMIT around
-- raw DDL would not actually pin a transaction. Wrap the four steps
-- in one DO-block instead: each step is conditional on its
-- pg_type/information_schema observation, so a partial failure on any
-- step can be recovered by re-running the migration.
DO $$
BEGIN
  -- Step 1: rename the existing enum out of the way (skip if already done).
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'storage_type')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'storage_type_with_nfs')
  THEN
    EXECUTE 'ALTER TYPE "storage_type" RENAME TO "storage_type_with_nfs"';
  END IF;

  -- Step 2: create the new narrowed enum (skip if already done).
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'storage_type') THEN
    EXECUTE 'CREATE TYPE "storage_type" AS ENUM (''ssh'', ''s3'', ''cifs'')';
  END IF;

  -- Step 3: re-point the column at the new enum (skip if already done).
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'backup_configurations'
      AND column_name = 'storageType'
      AND udt_name = 'storage_type_with_nfs'
  ) THEN
    EXECUTE 'ALTER TABLE backup_configurations '
         || 'ALTER COLUMN "storageType" TYPE "storage_type" '
         || 'USING ("storageType"::text::"storage_type")';
  END IF;

  -- Step 4: drop the old enum (skip if already done).
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'storage_type_with_nfs') THEN
    EXECUTE 'DROP TYPE "storage_type_with_nfs"';
  END IF;
END $$;
