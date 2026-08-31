-- Per-tenant recycle-bin state, so the expiry reconciler knows which tenants
-- are worth waking.
--
-- The file-manager sidecar is scaled to 0 after 10 minutes idle, and its PVC is
-- RWO — reading a tenant's bin means starting a pod and taking the volume lock.
-- A reconciler that swept blindly would start every tenant's pod on every pass
-- (50-100 tenants x 4 passes/day) to discover that almost all of the bins are
-- empty, and would contend with storage operations for the RWO lock.
--
-- This table is a CACHE, never the truth: the trash itself lives on the PVC and
-- is re-derived from observed contents on every interaction. It exists purely
-- so the reconciler can skip tenants that certainly have nothing to expire.
--
-- Safety direction matters. `oldest_deleted_at` may be EARLIER than reality
-- (waking a tenant for a sweep that finds nothing — cheap and self-correcting,
-- since the sweep refreshes the row) but must never be LATER, which would hide
-- an expired bin from the reconciler forever. Writers therefore take the
-- minimum, never overwrite with a newer value.
--
-- No FK: `tenant_id` is a loose reference like backup_jobs. A deleted tenant
-- takes its namespace and PVC with it, so a stale row here is inert and gets
-- cleaned up by the reconciler when the namespace lookup fails.
CREATE TABLE IF NOT EXISTS file_trash_state (
  tenant_id VARCHAR(36) PRIMARY KEY,

  -- Deletion timestamp of the oldest surviving entry, or NULL when the bin is
  -- known to be empty. Drives candidate selection.
  oldest_deleted_at TIMESTAMP,

  -- Bytes the bin occupies, for the admin storage overview. Informational only.
  used_bytes BIGINT NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,

  -- Stamped for EVERY tenant the reconciler examines, whatever the outcome,
  -- and used to order candidates.
  --
  -- This is the lesson from the restic reclamation sweep (migration 0095):
  -- recording only on success meant skipped subjects never got a row, kept
  -- sorting first under NULLS FIRST, and starved the tail — 131 repositories,
  -- 21 ever recorded, four consecutive sweeps of zero progress. Recording every
  -- examination makes coverage a true round robin.
  last_sweep_at TIMESTAMP,
  last_sweep_outcome VARCHAR(32),
  last_sweep_error TEXT,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Candidate selection: non-empty bins, least-recently-examined first.
CREATE INDEX IF NOT EXISTS file_trash_state_oldest_idx
  ON file_trash_state (oldest_deleted_at)
  WHERE oldest_deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS file_trash_state_last_sweep_idx
  ON file_trash_state (last_sweep_at);

-- Retention window for the bin, admin-adjustable next to its siblings
-- (snapshot_expiry_hours, deleted_tenant_bundle_retention_days).
--
-- It lives in the DB rather than in the file-manager pod's env because
-- ensureFileManagerRunning drift-checks the Deployment on pvc/caps/image/
-- resources/pullPolicy/nodeSelector and NOT on env: a pod-baked value would
-- freeze at the moment each tenant's Deployment was created and never pick up
-- an admin change. The backend reads this and passes it on every purge call.
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS file_trash_retention_days INTEGER NOT NULL DEFAULT 14;
