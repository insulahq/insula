-- Tenant snapshots: a step timeline for restores, and the real data size of
-- each snapshot.
--
-- storage_operations.progress_steps
--   The in-place snapshot restore runs seven steps (stop workloads → release
--   the volume → maintenance-attach → revert → detach → start workloads). Until
--   now only the CURRENT step survived, as one line in progress_message, so the
--   progress modal could show a bar and a sentence but not which steps had
--   finished, how long each took, or which one failed. The orchestrator now
--   writes `{ steps: [...], inFlight: {...} | null }` here after every step.
--   NULL for ops that record no steps, and for every op that ran before this
--   migration — the UI falls back to the progress bar for those.
--
-- tenant_volume_snapshots.longhorn_volume_name / longhorn_snapshot_name
--   The Longhorn volume + snapshot CR behind the CSI VolumeSnapshot, read once
--   from the VolumeSnapshotContent's snapshotHandle (snap://<volume>/<snapshot>)
--   when the snapshot becomes ready. With the names on the row, the list reads
--   every snapshot's data size (Longhorn status.size) with ONE label-selected
--   list of snapshots.longhorn.io instead of two GETs per row. NULL = not
--   resolved yet; rows created before this migration resolve on their next list.
--
-- All three are nullable with no default: existing rows are correct as NULL,
-- and no writer is bound by them. Replay-safe: IF NOT EXISTS.
ALTER TABLE "storage_operations" ADD COLUMN IF NOT EXISTS "progress_steps" jsonb;

ALTER TABLE "tenant_volume_snapshots" ADD COLUMN IF NOT EXISTS "longhorn_volume_name" varchar(253);

ALTER TABLE "tenant_volume_snapshots" ADD COLUMN IF NOT EXISTS "longhorn_snapshot_name" varchar(253);

COMMENT ON COLUMN "storage_operations"."progress_steps" IS
  'Step timeline of a multi-step op: { steps: [{ key, ok, startedAt, finishedAt, detail }], inFlight: { key, startedAt } | null }. NULL when the op records no steps.';

COMMENT ON COLUMN "tenant_volume_snapshots"."longhorn_snapshot_name" IS
  'snapshots.longhorn.io CR behind the CSI VolumeSnapshot (from the VolumeSnapshotContent snapshotHandle). NULL until resolved.';
