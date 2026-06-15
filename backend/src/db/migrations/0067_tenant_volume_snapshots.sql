-- On-server tenant volume snapshots (Longhorn CSI VolumeSnapshot, type=snap)
-- + the admin-adjustable expiry. These are short-term PVC recovery points the
-- tenant manages from the tenant panel — NOT off-site backups (those are the
-- restic tenant bundles). Each expires after snapshot_expiry_hours; a reaper
-- deletes the VolumeSnapshot CR (Longhorn snapshot cascades) + the row.

ALTER TABLE "system_settings"
  ADD COLUMN IF NOT EXISTS "snapshot_expiry_hours" INTEGER NOT NULL DEFAULT 48;

CREATE TABLE IF NOT EXISTS "tenant_volume_snapshots" (
  "id" VARCHAR(36) PRIMARY KEY,
  "tenant_id" VARCHAR(36) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "namespace" VARCHAR(255) NOT NULL,
  "pvc_name" VARCHAR(253) NOT NULL,
  "volume_snapshot_name" VARCHAR(253) NOT NULL,
  "label" TEXT,
  "status" VARCHAR(16) NOT NULL DEFAULT 'creating',
  "size_bytes" BIGINT NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "triggered_by_user_id" VARCHAR(36),
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "ready_at" TIMESTAMP,
  "expires_at" TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS "tenant_volume_snapshots_tenant_idx"
  ON "tenant_volume_snapshots" ("tenant_id");
CREATE INDEX IF NOT EXISTS "tenant_volume_snapshots_expires_idx"
  ON "tenant_volume_snapshots" ("expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_volume_snapshots_vs_name_unique"
  ON "tenant_volume_snapshots" ("namespace", "volume_snapshot_name");
