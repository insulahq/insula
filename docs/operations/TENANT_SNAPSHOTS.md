# Tenant Storage — Snapshots, Restore & Resize (Operator Runbook)

> On-server **point-in-time snapshots** of a tenant's storage volume (Longhorn
> CSI), **full-volume restore** (in-place Longhorn `snapshotRevert`), and
> **destructive resize/shrink**. R19.
>
> Roadmap context:
> [ROADMAP.md → R19](../roadmap/ROADMAP.md#r19--tenant-on-server-snapshots--storage-resize-hardening).
> Off-site tenant *bundles* (the Plesk-style restore cart) are a different
> system — see [TENANT_BACKUP.md](TENANT_BACKUP.md). Snapshots here are on-server
> and fast; bundles are off-site and portable.

## Two surfaces, one engine

| Surface | Who | What |
|---------|-----|------|
| **Tenant panel → Snapshots** | tenant | Create / list / delete on-server snapshots; restore the whole volume to one |
| **Admin → tenant storage** | operator | Manual snapshot, dry-run + **destructive shrink**, rollback to a snapshot |

Both drive the `storage-lifecycle` engine. A tenant has at most one in-flight
storage operation; `storage_lifecycle_state` mirrors the current phase
(`idle` → `quiescing` → … → `idle`, or `failed`).

## On-server snapshots (tenant-facing)

A snapshot is a Longhorn CSI `VolumeSnapshot` of the tenant's `<ns>-storage`
PVC. It is **near-instant**, lives **on the same disk** as the volume, and is
**not** a backup — it disappears if the volume is lost. Use it as a quick "undo
point" before a risky change (plugin update, bulk edit).

- **Create:** `POST /api/v1/tenants/:tenantId/snapshots` (optional `label`).
- **List:** `GET …/snapshots` → snapshots + `expiryHours`.
- **Delete:** `DELETE …/snapshots/:snapshotId`.
- **Auto-expiry:** each snapshot expires after `system_settings.snapshot_expiry_hours`
  (**48 h** by default). A reaper runs every ~30 min and deletes the
  VolumeSnapshot CR + row past expiry.
- **Cap:** a per-tenant ceiling (20 by default) prevents snapshot sprawl.

Status badges: `creating` → `ready` (green) / `error` (red, shows the reason) /
`deleting`. `sizeBytes` is 0 until `ready`.

## Full-volume restore (in-place revert)

Restoring rolls the **entire** volume back to a snapshot — anything written since
is lost and the site is briefly offline. The tenant panel shows an amber warning
and a progress modal ("Quiescing workloads" → "Reverting your volume" → "Scaling
back up").

- **Trigger:** `POST …/snapshots/:snapshotId/restore` → `202 { operationId }`.
- **Poll:** `GET …/snapshots/restore-status/:operationId`.

**Mechanism (why it's safe-by-design):** the restore is an **in-place Longhorn
`snapshotRevert`**, *not* a clone or PVC swap:

1. Pre-checks: the snapshot's `spec.volume` must match the PVC's bound volume and
   be `readyToUse`; the volume must not be `faulted`.
2. **Quiesce:** scale every Deployment in the tenant namespace to 0 and suspend
   CronJobs; wait until **no pod is mounting** `<ns>-storage`.
3. Maintenance-attach the detached volume (`disableFrontend`), issue
   `snapshotRevert` against `longhorn-backend:9500`, then detach.
4. **Unquiesce:** restore the prior replica counts and resume CronJobs.

The **PVC is never deleted** and the snapshot is **not consumed** (you can restore
again). On a mid-flight failure the engine still best-effort detaches and remounts
the old state.

> **`SNAPSHOT_VOLUME_MISMATCH` (409).** In-place revert only works on the *same*
> Longhorn volume the snapshot came from. If a prior **shrink** (which recreates
> the volume) or a different restore has since replaced the volume, the snapshot
> is stranded and can't be reverted in place — restore it as a **retained
> volume** (next section), or recover from the off-site bundle.

## Restore from a retained volume (operator)

When a destructive **shrink** (or archive) recreates the PVC, the *old* Longhorn
volume is **not destroyed** — the `longhorn-tenant` StorageClass is
`reclaimPolicy: Retain`, so the PV goes `Released` and the volume stays detached
with its snapshots intact. If a snapshot was taken **before** the shrink, you can
roll the tenant back onto that retained volume — this is the recovery path for the
`SNAPSHOT_VOLUME_MISMATCH` case above (the snapshot the in-place revert refuses
lives on the retained volume, not the current one).

- **Where:** admin panel → tenant detail → the amber **"Restore from a retained
  volume"** card. It renders only when the tenant *has* a retained volume, so most
  tenants never see it. Pick the volume's snapshot, then type the PV name to
  confirm. Tenant-scoped — an admin can only address volumes that belonged to
  *this* tenant.
- **API:** `GET …/admin/tenants/:id/storage/retained-volumes` (discovery) →
  `POST …/admin/tenants/:id/storage/restore-retained { pvName, snapshotName }`
  → `{ operationId }`, polled via the shared storage-operation progress modal.

**Mechanism:** quiesce → Longhorn `snapshotRevert` on the **retained** volume at
the chosen snapshot → rebind the PVC to it by static `volumeName` (raising
`<ns>-storage-quota` first if the retained volume is larger than the current one)
→ unquiesce. The **volume currently in use is kept as a fallback** (left
`Released`, *not* deleted) so the restore is reversible — reclaim it later from
**Cluster → Orphaned Volumes** once you've verified the restored data.

> **Reaper safety.** The orphaned-volumes reaper will **not** auto-purge a
> `Released` volume that still holds a restorable (non-`volume-head`) snapshot —
> it's a deliberately-retained fallback. It only becomes an ordinary stale orphan
> once its snapshots expire (the 48h snapshot reaper), after which it ages out
> normally. So a freshly-retained volume can't be reaped out from under you.

## Destructive resize / shrink (operator)

Growing a PVC is online and non-destructive. **Shrinking is destructive** —
Longhorn/Kubernetes can't shrink in place, so the engine: quiesce → capture a
pre-resize **files-only off-site bundle** → delete the PVC → recreate it smaller
→ restore the bundle → unquiesce. The tenant is **down** for the duration.

- **Dry-run first:** `POST /api/v1/admin/tenants/:tenantId/storage/resize/dry-run`
  (`{ newGi }`) → `{ usedBytes, willFit, rejectReason, estimatedSeconds }`. If
  the data doesn't fit the target size, it's rejected here.
- **Execute:** `POST …/storage/resize` (`{ newGi }`) → `{ operationId }`.
- **Rollback to a snapshot:** `POST …/storage/rollback` (`{ snapshotId }`).

### Hard prerequisite — a tenant-class backup target

A shrink **fails fast with `NO_SNAPSHOT_TARGET` (409)** unless a backup target is
bound to the `tenant_snapshot` class (the pre-resize bundle has nowhere to go
otherwise). Configure one under **Admin → Backup Settings** and bind it to the
`tenant` class first (CLI: `platform-ops backup target bind tenant <id>`).

> Don't shrink by tiny amounts — the full quiesce→snapshot→recreate→restore cycle
> runs regardless of how little you reclaim. The pre-resize bundle is retained 7
> days.

## Verification

```bash
# Tenant storage state is idle (no stuck operation): the admin tenant detail
# (GET /api/v1/admin/tenants/:id) reports storageLifecycleState == "idle".

# After a restore: the PVC's bound volume is UNCHANGED (in-place revert)
kubectl -n <tenant-ns> get pvc <ns>-storage -o jsonpath='{.spec.volumeName}'

# After a shrink: the PVC is the new (smaller) size and workloads are back up
kubectl -n <tenant-ns> get pvc <ns>-storage -o jsonpath='{.spec.resources.requests.storage}'
kubectl -n <tenant-ns> get deploy
```

Then drive the real flow: write a marker file → snapshot → change it → restore →
confirm the marker is back and the site serves.

## Troubleshooting

- **Shrink fails immediately with `NO_SNAPSHOT_TARGET`.** No `tenant_snapshot`
  backup target is bound — see the prerequisite above.
- **Restore fails with `SNAPSHOT_VOLUME_MISMATCH`.** The volume was recreated
  (usually by a prior shrink) — the snapshot can't be reverted in place; use the
  off-site bundle.
- **Force-cancel left the tenant down (quiesced).** A cancelled operation can
  leave workloads scaled to 0. Recover manually by restoring each Deployment's
  replicas:
  ```bash
  kubectl -n <tenant-ns> get deploy           # see who is at 0/0
  kubectl -n <tenant-ns> scale deploy/<name> --replicas=1
  ```
  (Do **not** `rollout restart` — on a Flux-managed cluster that fights the
  reconciler; scale the Deployment directly.)
- **A snapshot/shrink Job hangs for minutes.** `waitForQuiesced` waits for pods
  to actually stop mounting the PVC; on a loaded node kubelet teardown is slow.
  Give it time before assuming failure; check the snapshot Job's pod events.
- **Large shrink/backup fails with an S3 `NoSuchUpload` / multipart error.**
  **Known open issue (R19):** the in-cluster `rclone serve s3` shim fails
  multipart uploads larger than ~1 GiB. Small captures (e.g. mail) succeed; large
  tenant volumes don't. Mitigation until fixed: bind the `tenant_snapshot` class
  to a **real** S3 endpoint (Hetzner/MinIO), which streams multipart fine, rather
  than the in-cluster shim.
- **The red "a storage operation failed" banner won't clear.** It's gated on
  `storage_lifecycle_state == 'failed'`. Once the operation is rolled back to
  `idle` it clears; if it's stuck `failed`, inspect `storage_operations.last_error`
  for that tenant.

## Schema reference

| Table | Holds |
|-------|-------|
| `tenant_volume_snapshots` | on-server CSI snapshots: namespace, pvc_name, volume_snapshot_name, status, size, `expires_at` |
| `storage_snapshots` | pre-resize / pre-archive / manual archival snapshots (off-site bundles), `kind`, `archive_path`, `target_id` |
| `storage_operations` | every lifecycle op: `op_type`, `state`, `progress_pct/message`, `params` (incl. the quiesce snapshot), `last_error` |
| `tenants.storage_lifecycle_state` / `active_storage_op_id` | the tenant's current phase + in-flight op guard |

`system_settings.snapshot_expiry_hours` (default 48) controls on-server snapshot
TTL. Migration `0067` adds `tenant_volume_snapshots` + the expiry setting.

## Where things live

- Engine: `backend/src/modules/storage-lifecycle/` (`service.ts`, `longhorn-revert.ts`,
  `quiesce.ts`, `prebundle.ts`, `streaming-store.ts`, `scheduler.ts`).
- Tenant snapshots: `backend/src/modules/tenant-snapshots/` (`routes.ts`,
  `service.ts`, `scheduler.ts`) + contracts in
  `packages/api-contracts/src/tenant-snapshots.ts`.
- Tenant UI: `frontend/tenant-panel/src/pages/Snapshots.tsx`,
  `components/LifecycleBanner.tsx`.
- Longhorn API: `http://longhorn-backend.longhorn-system:9500`
  (override `LONGHORN_API_BASE`).

## Per-file restore vs whole-volume restore

On-server snapshots here only support **whole-volume** revert. To pull back
**individual files or folders** without reverting everything, use the **bundle
restore cart** (off-site restic backups) — it has a file-tree browser and a
`files-paths` item that restores just the selected paths (idempotent overwrite,
with a pre-restore snapshot as a rollback target). That path shipped 2026-06-16
(#105); see [TENANT_BACKUP.md](TENANT_BACKUP.md).

## Still open (R19)

- **Destructive-shrink quiesce — FIXED 2026-06-17.** Single-node shrink used to
  hang at "Scaling workloads to zero": the SDK serializer silently dropped
  `replicas: 0` (scale-to-0 was a no-op), and even once that was fixed the
  file-manager auto-restarted within ~2s and fought quiesce. Now quiesce scales
  via the `/scale` subresource, stamps an `insula.host/storage-quiesced`
  annotation that blocks the file-manager auto-start until the op finishes, and
  force-deletes a pod stuck `Terminating` past a grace window. Shrink now
  succeeds on the first attempt.
- **rclone-shim multipart > 1 GiB** — no longer *reached* (every tenant-data
  path goes through restic's 64 MiB chunked packs since #118); an unreached
  engine property, not an active blocker.
- **force-cancel** of a storage op can still leave a tenant's *other* workloads
  scaled to 0 (manual `kubectl scale` recovery); the cancel now at least clears
  the file-manager quiesce-hold so file access recovers.
