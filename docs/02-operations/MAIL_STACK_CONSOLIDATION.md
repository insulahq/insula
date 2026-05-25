# Mail-stack PVC consolidation runbook (A2 → A2.5)

> **Status**: A2 shipped. A2.5 pending operator-validated cutover on staging.

## What this does

Migrates the legacy two-PVC mail layout into a single consolidated
`mail-stack-data` PVC. Stalwart and Bulwark both end up mounting the
same local-path volume via subPaths:

| Legacy (before) | Consolidated (after) |
|---|---|
| `stalwart-rocksdb-data` PVC, local-path 20Gi, mounted at `/var/lib/stalwart/data` | `mail-stack-data` PVC, **subPath=`stalwart`** at `/var/lib/stalwart/data` |
| `bulwark-data` PVC, **Longhorn** RWO 1Gi, mounted at `/app/data` | `mail-stack-data` PVC, **subPath=`bulwark`** at `/app/data` |

### Why

- **Single backup primitive**: one restic snapshot covers both subtrees.
- **Single failover primitive**: one PVC follows the active node.
- **Local-path for both**: Bulwark moves off Longhorn (per the 2026-05-22
  storage perf bench — Longhorn RocksDB workloads are 3-7× slower; Bulwark
  is 60 KB so the perf delta is irrelevant, but co-locating on local-path
  eliminates Longhorn's replication overhead and unifies the backup story).
- **Atomic mail stack**: failover moves both pods + both data subtrees as
  one unit.

## When to run this

On any cluster that has the legacy two-PVC layout. New installs from
the A2.5 commit onward start with the consolidated layout — no
migration needed.

### Detect legacy layout

```bash
kubectl get pvc -n mail
# Legacy:    bulwark-data + stalwart-rocksdb-data + mail-stack-data (Pending until cutover)
# Migrated:  mail-stack-data (Bound) + legacy two for safety
# A2.5 done: mail-stack-data (Bound) only
```

## Two-stage cutover

### Stage 1 — Data migration (A2 ships, operator runs)

A2 ships the new `mail-stack-data` PVC manifest (sits Pending) +
the `scripts/mail-stack-consolidate.sh` script. Operator runs the
script to migrate data while Deployments are still using legacy PVCs.

**Pre-flight**:
- `mail-stack-data` PVC exists (Pending is fine).
- Active mail node is healthy.
- A fresh restic snapshot exists (script triggers one automatically).
- Maintenance window agreed (~30-60s mail downtime).

**Run**:
```bash
# Dry-run preview
./scripts/mail-stack-consolidate.sh

# Apply
./scripts/mail-stack-consolidate.sh --apply
```

**What the script does** (in order):
1. Triggers `stalwart-snapshot` CronJob to capture latest Stalwart data.
2. Scales `stalwart-mail` + `bulwark` Deployments to 0 (mail down).
3. Waits for pods to terminate (PVCs released).
4. Spawns one-shot `mail-stack-data-mover` Pod on the active node:
   - Mounts `stalwart-rocksdb-data` at `/src/stalwart` (RO)
   - Mounts `bulwark-data` at `/src/bulwark` (RO)
   - Mounts `mail-stack-data` at `/dst` (RW)
   - `cp -a /src/stalwart/. /dst/stalwart/`
   - `cp -a /src/bulwark/. /dst/bulwark/`
   - Verifies file counts match.
   - Writes sentinel `/dst/.mail-stack-consolidated-at`.
5. Scales Deployments back to 1.

After Stage 1: legacy PVCs still mounted by Deployments. New PVC
holds a complete copy. Mail is back up on the legacy layout.

### Stage 2 — Manifest cutover (A2.5 ships, Flux applies)

A2.5 commit changes the Deployment manifests + snapshot CronJob to
mount `mail-stack-data` with subPaths instead of the legacy PVCs.
Flux applies → Pods restart → mount the new PVC → data is already
there (placed by Stage 1).

**Pre-flight before merging A2.5**:
- Verify Stage 1 sentinel exists on the consolidated PVC.
- Mail is currently up + healthy on legacy layout.

**Post-A2.5 verification**:
```bash
kubectl get pod -n mail -l 'app in (stalwart-mail,bulwark)' -o wide
# Both should be Running on the same node with new PVC mounted.

kubectl exec -n mail deploy/stalwart-mail -- ls -la /var/lib/stalwart/data/CURRENT
# CURRENT sentinel present → RocksDB happy.

kubectl exec -n mail deploy/bulwark -- ls /app/data/admin/admin.json
# admin.json present → Bulwark admin auth intact.
```

### Stage 3 — Legacy cleanup (operator, after sanity period)

See "Stage 3 cleanup criteria" below for the wait period + verification
checklist. **Wait at least 48-72h** before deleting legacy PVCs.

Free up the underlying local-path directory + Longhorn replicas.

## Rollback

If something goes wrong between Stage 1 and Stage 2, the legacy
PVCs still hold the data (Stage 1 only copies, never deletes).
Rollback = revert A2.5 (Deployments mount legacy PVCs again).

If something goes wrong AFTER Stage 3 (legacy PVCs deleted) and the
consolidated PVC is also corrupted: restore from restic snapshot via
the standard restore-state init container flow (set
`mail.platform/allow-restore=true` annotation on the Stalwart
Deployment + scale to 0 then 1).

## Recovery if Stage 1 script aborts mid-run

The script can crash between scaling Deployments to 0 (line ~157)
and scaling them back to 1 (line ~225). If this happens, mail stays
down until the operator acts:

```bash
# 1. Check that the data-mover Pod is gone (or kill it)
kubectl get pod mail-stack-data-mover -n mail
kubectl delete pod mail-stack-data-mover -n mail --ignore-not-found

# 2. Manually scale Deployments back to 1
kubectl scale deploy stalwart-mail bulwark -n mail --replicas=1

# 3. Wait for pods to come up
kubectl wait --for=condition=Ready --timeout=300s pod -n mail -l app=stalwart-mail
kubectl wait --for=condition=Ready --timeout=300s pod -n mail -l app=bulwark
```

Then either:
- **Re-run the script** (`./scripts/mail-stack-consolidate.sh --apply`):
  the idempotency sentinel check will skip if Stage 1 actually
  succeeded before the crash; otherwise it will retry the copy.
- **Or investigate the failure** in the script's log output before
  retrying.

## Scope: which clusters get the new PVC manifest

A2 adds `pvc-mail-stack.yaml` to `k8s/base/stalwart-mail/stalwart/`.
Every overlay that references that base will reconcile the manifest —
which today means **all overlays** (staging + production + dev). The
PVC sits `Pending` (local-path `volumeBindingMode: WaitForFirstConsumer`)
until the cutover script triggers first mount, so production sees no
behavior change from A2 alone. The actual cutover only happens when
an operator runs the script + A2.5 lands.

## Idempotency

The script checks for the sentinel file `.mail-stack-consolidated-at`
on the new PVC before doing anything. If present, exits 0. Safe to
re-run.

## Stage 3 cleanup criteria

Wait at least **48-72h** with mail running on the consolidated layout
before deleting legacy PVCs. Verify in this window:
- At least one successful restic snapshot round-trip from the new
  PVC (`kubectl get cronjob stalwart-snapshot -n mail` + check
  `.status.lastSuccessfulTime`).
- Bulwark admin auth works (login via webmail UI).
- IMAP + SMTP traffic flows through Stalwart on the consolidated
  layout.

Then:
```bash
kubectl delete pvc stalwart-rocksdb-data bulwark-data -n mail
```

## Idempotency

The script checks for the sentinel file `.mail-stack-consolidated-at`
on the new PVC before doing anything. If present, exits 0. Safe to
re-run.

## Related

- `[[scripts/mail-stack-consolidate.sh]]` — the script itself.
- `[[k8s/base/stalwart-mail/stalwart/pvc-mail-stack.yaml]]` — the new PVC manifest.
- `[[backend/src/modules/mail-admin/migration.ts]]` — `MAIL_STACK_DEPLOYMENTS`
  co-location list (A1 commit ce8748d3).
- Project memory: `project_stalwart_storage_perf_2026_05_22` — why local-path.
