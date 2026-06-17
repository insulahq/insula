# Admin restore-from-retained-volume (design)

> Admin-driven restore of a tenant PVC from a **retained (detached) Longhorn
> volume** — the old volume left behind by a destructive shrink when a manual
> snapshot was taken first. Born from the tenant-9649 shrink incident
> (2026-06-16). Sibling of the in-place revert
> ([TENANT_SNAPSHOTS.md](../operations/TENANT_SNAPSHOTS.md), #102) and the off-site
> bundle restore cart ([TENANT_BACKUP.md](../operations/TENANT_BACKUP.md)).

## Problem

A destructive **shrink** (`storage-lifecycle/service.ts:runResizeDestructive`)
quiesces → captures an off-site restic bundle → **deletes the PVC** → recreates it
smaller → restores the bundle. Today the existing in-place snapshot restore
(`restoreTenantFromVolumeSnapshot`, #102) **refuses** any snapshot whose Longhorn
volume is no longer the PVC's bound volume — `SNAPSHOT_VOLUME_MISMATCH` (409) — so a
manual snapshot taken right before a shrink is unreachable afterwards. The runbook
currently tells operators to "recover from the off-site bundle instead." That's the
gap this feature closes: let an admin roll the tenant back onto that retained
volume at a chosen snapshot.

## Key architectural facts (grounded 2026-06-17)

1. **Retention is already automatic.** The `longhorn-tenant` StorageClass is
   `reclaimPolicy: Retain` (`k8s/base/longhorn/storageclasses.yaml:125`). After a
   post-#122 shrink (which preserves the SC), deleting the old PVC leaves its PV
   **`Released`** and the Longhorn volume **detached but intact, with its
   snapshots** — i.e. the "retained volume" already exists. No retain-on-shrink
   code is required. (Pre-#122 shrinks that fell back to the default `longhorn` SC
   used `reclaimPolicy: Delete` and did NOT retain — that bug is fixed.)
2. **The retained volume survives indefinitely.** Orphan reaping
   (`orphaned-volumes/service.ts`) is **operator-initiated only** (no scheduler);
   `detectOrphans` flags a Released PV as `pv_released_stale` after **7 days**
   (`DEFAULT_STALE_PV_DAYS`), and `purgeAllOrphans`/`deleteOrphan` reclaims PV +
   Longhorn volume on demand. That 7-day flag is the natural **auto-reap window**
   (Q3); the just-replaced volume after a retained-restore re-enters the same path.
3. **Longhorn `type=snap` snapshots die with their volume.** Tenant on-server
   snapshots (`tenant_volume_snapshots`, class `longhorn`, in-cluster) live inside
   the volume; retaining the volume is the only way to keep them. (A `type=bak`
   backupstore backup would survive independently — not used here.)
4. **In-place revert plumbing is reusable.** `storage-lifecycle/longhorn-revert.ts`
   (`assertSnapshotRevertable`, `revertVolumeToSnapshot` = maintenance-attach via
   `longhorn-backend:9500` → `?action=snapshotRevert` → detach,
   `resolveLonghornSnapshotFromCsi`, `parseSnapshotHandle`) already reverts a
   detached volume. We point it at the retained volume instead of the bound one.

## Locked decisions (user, 2026-06-17)

- **Q1 — the volume currently bound at restore time (e.g. 9649's restic-restored
  copy):** **retain as a fallback, reclaim later** — do NOT delete it on cutover.
- **Q2 — default point-in-time:** **the chosen snapshot** on the retained volume.
- **Q3 — fallback reclaim:** **auto-reap after a retention window** (the existing
  `pv_released_stale` orphan path).
- **Q5 — what makes a retained volume exist:** **a manual snapshot taken before the
  shrink** (otherwise the retained volume only mirrors the restic-restored state and
  has no useful point-in-time to choose).

## Design

### 1. Discovery (read-only)
`listRetainedVolumesForTenant(db, k8s, tenantId)` → for the tenant's namespace,
find **Released** PVs whose `claimRef.namespace` matches (these are the tenant's
prior volumes), join the Longhorn volume CR + its snapshots, and return:
`{ pvName, longhornVolumeName, sizeBytes, releasedAt, snapshots: [{ name, createdAt,
sizeBytes, label? }] }`. Only volumes that still carry ≥1 restorable snapshot are
offered. Security: like `findOrphan`, only ever returns volumes claim-reffed to
THIS tenant's namespace — never an arbitrary volume by name.

### 2. Restore-from-retained orchestration
`restoreTenantFromRetainedVolume(ctx, tenantId, { pvName, snapshotName })`:
1. Resolve + **guard**: the PV must be `Released`, claim-reffed to this tenant's
   namespace, carry `snapshotName`, and **not** be the PVC's currently-bound volume
   (that's the in-place-revert path — return a clear error pointing there).
2. **quiesce** the tenant (reuse `quiesce`/`waitForQuiesced`).
3. **revert** the retained volume to the chosen snapshot
   (`revertVolumeToSnapshot`) [Q2].
4. **Rebind the PVC (the swap):**
   - Read the current PVC's bound volume → this becomes the **new fallback**.
   - Delete the current PVC → its PV goes `Released` (Retain SC) = fallback [Q1].
   - Clear the retained PV's `spec.claimRef` → PV returns to `Available`.
   - Create a new PVC `<ns>-storage` with `spec.volumeName=<retainedPV>`,
     `storageClassName: longhorn-tenant`, and the retained volume's size →
     **static-binds** to the retained PV. (No dynamic provisioning, no clone — the
     dataSource-clone path is abandoned, it stalls `copy-completed-awaiting-healthy`
     while detached.)
5. **unquiesce** (restore prior replica counts).
6. Op row `op_type='restore'`, `params.mode='retained_volume'`,
   `params.fallbackVolume=<old bound volume>`. The fallback PV is now `Released` and
   re-enters the orphan reaper's 7-day window [Q3].

Failure handling mirrors `runRestoreFromSnapshot`: best-effort unquiesce; the PVC
is only deleted once the retained volume is reverted and Available, to minimise the
window where the tenant has no bound PVC.

### 3. Reaper guard
`detectOrphans` must not let an operator (or a future scheduler) silently purge a
retained volume that still holds live manual snapshots inside the chosen-undo
window. Options: (a) surface a distinct `reason` / flag for "retained volume with
snapshots" so the orphan UI warns before delete; (b) keep the 7-day window as the
auto-reap [Q3] but exclude snapshot-bearing Released PVs from `purgeAllOrphans`
until a longer window. Minimum: don't regress the data-safety the Retain SC buys.

### 4. API + UI
- `GET /admin/tenants/:tenantId/storage/retained-volumes` → discovery list.
- `POST /admin/tenants/:tenantId/storage/restore-retained`
  `{ pvName, snapshotName }` → `202 { operationId }` (poll existing
  `GET /admin/storage/operations/:operationId`).
- Contracts in `@insula/api-contracts` (rebuild `tsc --build --force`).
- Admin UI: a "Restore from a retained volume" panel on the tenant storage page —
  picker of retained volumes → snapshot → type-to-confirm (destructive: the live
  volume is swapped out). Reuses the storage operation progress modal.

## Phasing
- **P1** discovery (read-only) + design doc — safe, immediately useful.
- **P2** restore orchestration + routes + contracts + unit tests.
- **P3** reaper guard.
- **P4** admin UI + live E2E on testing (disposable tenant: snapshot → shrink →
  restore-from-retained → assert pre-shrink data back, old volume retained as
  fallback). Also: the **owed destructive-shrink E2E** (#122/#123) rides along.

## E2E acceptance (P4)
On a disposable tenant: write marker v1 → manual snapshot → shrink (recreates PVC,
old volume Released+retained) → write marker v2 → `restore-retained` to the v1
snapshot → tenant serves v1, PVC bound to the (reverted) retained volume, the v2
volume left `Released` as fallback, reaper reclaims it after the window.
