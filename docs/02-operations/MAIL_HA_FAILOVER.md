# Mail-stack HA failover / failback runbook

> **Status**: 2026-05-25 — operator-verified E2E on staging. Full
> code shipped: A1 (Bulwark co-location) → A2/A2.5 (consolidated
> mail-stack-data PVC) → A3 (standby data DaemonSet) → A4 (FAST
> PATH wiring + auto-failover state machine).

## What this runbook covers

- Architecture of the mail-stack HA primitives.
- Operator setup: choosing primary/secondary/tertiary nodes, enabling
  auto-failover.
- Failover triggers + expected behaviour.
- Manual failback after an outage.
- Edge cases observed during live destructive testing.
- Diagnostic queries + recovery commands.

## Critical mental model — the PVC does NOT migrate with the pod

The single most important thing to understand before reading this
runbook: when a failover happens, the `mail-stack-data` PVC on the
dying node is **destroyed** and a **fresh empty PVC** is created on
the target node. The data does NOT follow the pod.

This is intentional. The PVC uses `local-path` provisioner so files
live directly on one node's NVMe — the storage class delivers RocksDB
the I/O latency it needs (Longhorn would migrate the PVC across
nodes but is 3-7× slower per the 2026-05-22 storage perf bench;
that trade-off is rejected).

So "data preservation across node failure" comes from three layers
of restore, NOT from the PVC moving:

| Layer | Trigger | Latency | Source |
|---|---|---|---|
| **1. A3 standby DaemonSet FAST PATH** (default) | failover lands on a standby-labelled node with fresh `.standby-complete` | sub-second local copy | `/var/lib/mail-stack-standby/{stalwart,bulwark}/` on the new node |
| **2. restic restore** (fallback) | FAST PATH unavailable or stale (>30 min) | seconds-to-minutes via shim → upstream | restic repo (offsite per operator's BackupStore config) |
| **3. Fresh-start** (last resort) | both above fail | instant | empty PVC; Stalwart RocksDB initialises fresh, Bulwark generates a new admin.json |

For Bulwark specifically: if it lands in fresh-start mode, the
admin password is a new scrypt hash → operator must reset via the
admin panel or check the pod logs for the printed bootstrap
password. Stalwart's user mailboxes / mail metadata are similarly
gone (all data was in the destroyed PVC).

**In normal operation**, layer 1 (FAST PATH) handles the failover
silently and operators never see data loss. The other layers are
defence-in-depth.

## Architecture

```
                  ┌────────────────────────────────────────┐
                  │ k3s cluster (≥3 server nodes)          │
                  │                                         │
                  │  ┌────────────┐  ┌────────────┐         │
                  │  │ mailActive │  │ standby    │         │
                  │  │ Node       │  │ DaemonSet  │         │
                  │  │            │  │ (every 5m) │         │
                  │  │ • Stalwart │  │            │         │
                  │  │ • Bulwark  │  │ /var/lib/  │         │
                  │  │   (both    │  │ mail-stack-│         │
                  │  │   in same  │  │ standby/   │         │
                  │  │   PVC,     │  │            │         │
                  │  │   subPath) │  └────────────┘         │
                  │  └────────────┘                          │
                  │       ▲                                  │
                  │       │ HAProxy DaemonSet (ingress HA)   │
                  └───────┼──────────────────────────────────┘
                          │
                          ▼
              Mail clients (SMTP/IMAP/Sieve via hostPort 25/465/587/143/993/4190)
```

Three placement variables in `system_settings`:

| Column | Purpose |
|---|---|
| `mailPrimaryNode` | Operator's preferred home for the mail stack. Used by `POST /admin/mail/failback`. |
| `mailSecondaryNode` | First-choice failover target when `mailActiveNode` goes NotReady. |
| `mailTertiaryNode` | Fallback if secondary is also unavailable. |
| `mailActiveNode` | Live tracking — where the stack currently runs. Updated by every migration. Self-healed from kubectl on every read of `GET /admin/mail/placement`. |
| `mailAutoFailoverEnabled` | When true, `dr-watcher` triggers `triggerRestoreBasedFailover` automatically. |
| `mailFailoverThresholdSeconds` | Seconds NotReady before auto-failover fires. Default 300s (5 min). |

The `mail-stack-standby-replicate` DaemonSet runs on every node labelled
`insula.host/mail-standby=true`. Platform-api's
`ensureMailStackPlacementApplied` reconciler keeps that label aligned
with `mailSecondaryNode + mailTertiaryNode` — operators never label
nodes manually.

## Initial setup (new cluster)

1. **Configure placement** via admin panel → Mail → Placement, or DB:
   ```sql
   UPDATE system_settings SET
     mail_primary_node   = 'node-a',
     mail_secondary_node = 'node-b',
     mail_tertiary_node  = 'node-c'
   WHERE id = 'system';
   ```
2. **Enable auto-failover** (optional; default false):
   ```sql
   UPDATE system_settings SET
     mail_auto_failover_enabled   = true,
     mail_failover_threshold_seconds = 300
   WHERE id = 'system';
   ```
3. Wait one `dr-watcher` tick (~30s). The startup reconciler runs and:
   - Pins `stalwart-mail` + `bulwark` Deployments to `mailActiveNode`.
   - Adds `insula.host/mail-standby=true` label to
     `mailSecondaryNode` + `mailTertiaryNode`.
   - DaemonSet schedules pods on labelled nodes; first restic pull
     populates `/var/lib/mail-stack-standby/{stalwart,bulwark}/` and
     writes the `.standby-complete` sentinel.
4. **Verify standby readiness** on each labelled node:
   ```bash
   ssh <secondary> "ls /var/lib/mail-stack-standby/.standby-complete"
   ```

## Failover scenarios

### Scenario A: Auto-failover on node death

Active node's kubelet dies, k8s reports `Ready=False/Unknown` within
~40s of last heartbeat.

1. `dr-watcher` (interval 30s) detects → state `healthy → degraded`,
   `mailLastFailoverAt = now()`.
2. Next tick logs `Node X still degraded — Ys / Zs threshold`.
3. After `mailFailoverThresholdSeconds`: state `degraded → failing-over`,
   call `triggerRestoreBasedFailover(mailSecondaryNode ?? mailTertiaryNode)`.
4. State machine:
   - Scale `stalwart-mail` + `bulwark` Deployments to 0 (atomic via
     `MAIL_STACK_DEPLOYMENTS` fan-out).
   - Wait for pods to terminate. After 30s, `forceDeleteStuckPodsOnDeadNodes`
     escalates: any pod on a NotReady node is force-deleted (grace=0),
     releasing the pvc-protection finalizer.
   - Delete the legacy PVC.
   - Create new `mail-stack-data` PVC pinned to target node via
     local-path provisioner.
   - Patch Deployments: nodeSelector to target node;
     `allow-restore=true` annotation on stalwart-mail's pod template.
   - Scale Deployments back to 1.
   - Pods spawn on target node, both init containers run.
5. **FAST PATH**: Stalwart + Bulwark restore-state init containers
   read `/standby-data/{stalwart,bulwark}/` (hostPath) and check
   `.standby-complete` sentinel. If present + sentinel data complete,
   `cp -a` into the new PVC's subPath. Bypasses restic entirely.
   Sub-second restore vs minutes for the network restic pull.
6. Pods become Ready. State machine writes `mailActiveNode = target`,
   `mailDrState = 'failed-over'`.

Total time-to-recovery on a 13 MB working set: ~2-3 minutes from node
death to Stalwart Ready.

### Scenario B: Operator-triggered explicit migration

`POST /admin/mail/migration` with `{ intent: { kind: 'explicit', targetNode: 'node-X' } }`.

Same state machine as auto-failover but:
- Skips the threshold countdown.
- Takes a fresh stalwart-snapshot first (source PVC is still reachable).
- Uses `mailPrimaryNode` is NOT consulted; operator explicitly names
  target.

### Scenario C: Manual failback

`POST /admin/mail/failback` (no body).

- Resolves target = `mailPrimaryNode`. Errors with
  `MAIL_PLACEMENT_NO_CANDIDATE` if unset.
- Runs the same state machine as explicit migration. The active node
  becomes the new "source" — fresh snapshot, scale down, swap PVC,
  scale up on `mailPrimaryNode`.
- After success, `mailActiveNode = mailPrimaryNode` (back to operator's
  preferred home).

### Failback considerations

- Failback is **operator-triggered** only. There is no auto-failback —
  this is intentional. Auto-failback would risk flapping if the original
  primary's recovery is unstable (still warming up, post-restart kubelet
  flap, etc.).
- Before triggering failback, verify the original primary is genuinely
  healthy:
  ```bash
  kubectl get node mailPrimaryNode -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
  # → True for at least 5-10 min, no kubelet/k3s restarts
  ```
- If auto-failover is enabled, the standby DaemonSet starts pre-staging
  data on `mailPrimaryNode` as soon as the placement reconciler labels
  it. Wait for `.standby-complete` to appear before failing back, so
  failback also uses FAST PATH:
  ```bash
  ssh mailPrimaryNode "cat /var/lib/mail-stack-standby/.standby-complete"
  ```
- If failback is needed urgently before standby data has populated,
  the state machine falls back to restic restore (takes minutes
  instead of seconds, but works).

## Edge cases observed during E2E testing

### 1. Source-node pods stuck Terminating

When kubelet on the source node is dead, pods sit `Terminating` forever
(kubelet never confirms graceful termination). The PVC's
`pvc-protection` finalizer blocks PVC deletion indefinitely.

**Mitigation in code (`forceDeleteStuckPodsOnDeadNodes`)**: after 30s
of waiting for the PVC to disappear, the migration helper enumerates
pods mounting the PVC, checks node `Ready` status, and force-deletes
(grace=0) any pod whose node is NotReady/Unknown.

**Operator action**: none needed. The escalation is automatic. If for
some reason it doesn't fire (platform-api crash mid-migration), the
manual recovery is:
```bash
kubectl delete pod -n mail <stuck-pod> --grace-period=0 --force
kubectl patch pvc mail-stack-data -n mail -p '{"metadata":{"finalizers":null}}' --type=merge
```

### 2. dr-watcher refuses to retry

Pre-A4 bug: when migration failed, `mailDrState` was wrongly stamped
`failed-over` and dr-watcher refused to retry (it only acts on
healthy/degraded). Fixed in 2026-05-25 (`b48f5cf4`): state machine's
`failRun + return` intermediate paths now re-throw via a post-call
DB-state check. dr-watcher's existing catch handler resets to
`degraded` for next-tick retry.

**How to spot stuck failover state today**:
```sql
SELECT id, state, current_step, error_message, started_at
FROM mail_migration_runs
ORDER BY started_at DESC
LIMIT 3;
```
A run stuck in `state='failed'` paired with `mail_dr_state='failed-over'`
is the legacy bug. Manual recovery: `UPDATE system_settings SET
mail_dr_state='degraded' WHERE id='system'` → dr-watcher retries.

### 3. Standby data stale (max-age gate)

The FAST PATH gates on the `.standby-complete` sentinel written by
`standby-replicate.sh` only after both `stalwart/` and `bulwark/`
subtrees finish copying. Partial restores (DaemonSet killed
mid-cp) are invisible to the failover code.

If the standby DaemonSet has been down for a long time, the sentinel
would remain stale. **Max-age gate** (added 2026-05-25): the sentinel
stores epoch-seconds; both init containers reject the FAST PATH if
`now - sentinel_epoch > FAST_PATH_MAX_AGE_SECONDS` (default 1800s =
30 min, 6× the DaemonSet's 5-min cadence). Stalwart then falls
through to restic restore; Bulwark falls through to fresh-start.

Verified by live destructive test 2026-05-25: backdated sentinel
to 7268s old, triggered failover. Init logged:
```
restore-state: standby marker is 7268s old (limit 1800s) — rejecting FAST PATH, falling through to restic
```

**Operator awareness**: if a node was offline for hours, the failover
correctly falls through. No silent stale-data restore.

### 4. Bulwark fresh-start on failover with no standby data

If `/standby-data/bulwark/admin/admin.json` is absent AND no
`.standby-complete` marker exists, Bulwark falls through to "fresh
start" — new admin password generated. Operator must reset via the
admin panel or the bulwark-secrets reset flow. Stalwart data is
unaffected (separate restore path).

### 5. PSS conflict on init container `runAsUser`

Bulwark's Deployment sets pod-level `runAsNonRoot: true`. The
restore-state init container cannot override `runAsUser: 0`. Fixed
in `c46f096d` — the init runs as UID 1000 same as the main
container. `cp -a` preserves source ownership (standby files are
already UID 1000), so functional outcome is identical to a root cp.

### 6. Concurrent dr-watcher across HA-3 replicas — FIXED 2026-05-25

Each of the 3 platform-api replicas runs `dr-watcher` every 30s. If
multiple replicas detected NotReady simultaneously, they would all
call `triggerRestoreBasedFailover` in the same window → double-INSERT
into `mail_migration_runs` + competing PVC deletes.

**Fixed** by atomic CAS on both state transitions: every replica
runs `UPDATE system_settings SET mail_dr_state='failing-over' WHERE
mail_dr_state='degraded' RETURNING id`. Only the winning replica's
UPDATE affects a row; others see zero rows and skip. Same pattern
for `healthy → degraded`. Log messages moved inside the affected-rows
guard so we don't get "entering degraded" spam from every replica
on the same tick.

### 7. Concurrent operator migration + dr-watcher failover

`startMailMigration` (operator path) has a concurrency guard:
`SELECT FROM mail_migration_runs WHERE state NOT IN ('done','failed','rolled-back')`
returns 409 `MAIL_MIGRATION_ALREADY_RUNNING` if any active run exists.

**Limitation**: `triggerRestoreBasedFailover` (the dr-watcher path)
deliberately BYPASSES this guard — comment in code says "DR is
force-majeure". This means:

- Operator triggers explicit migration via `POST /admin/mail/migrate`.
- Active node dies during the migration.
- dr-watcher fires `triggerRestoreBasedFailover` → starts a SECOND
  state machine concurrently with the operator's first one.
- Both compete on PVC delete; first one's swapping-pvc step likely
  fails (target PVC already gone by the second's hand).

**Operator awareness**: when manually migrating, also temporarily
set `mailAutoFailoverEnabled=false` in `system_settings` to prevent
dr-watcher from competing. Re-enable after the migration completes.

```sql
-- Before manual migration:
UPDATE system_settings SET mail_auto_failover_enabled=false WHERE id='system';

-- After migration succeeds:
UPDATE system_settings SET mail_auto_failover_enabled=true WHERE id='system';
```

### 8. Worst-case fresh-start (no standby + no restic)

Both `restore-state` init containers (Stalwart, Bulwark) exit 0
cleanly when EVERY recovery path fails: empty PVC, no
`.standby-complete`, restic restore failed (or `RESTIC_REPOSITORY`
unset). The main containers then start with empty data:

- **Stalwart**: RocksDB initialises a fresh DB. All historical
  mail/users/etc. lost from the active store. Mail starts accepting
  new traffic.
- **Bulwark**: regenerates admin.json with a random scrypt-hashed
  password. Operator must reset via the admin panel (or check the
  pod's environment for the printed bootstrap password).

This behaviour is the SAFE failure mode — pods come up Ready, no
crashloop.

**Detecting a fresh-start (2026-05-25 alerting added)**:

Every fresh-start path in both init containers now writes a sentinel
file `.fresh-started-at` into the PVC, with content
`<iso-timestamp> reason=<why>`. The operator can detect a fresh-start
by checking either pod:

```bash
# Stalwart
kubectl exec -n mail deploy/stalwart-mail -c stalwart -- \
  cat /var/lib/stalwart/data/.fresh-started-at 2>/dev/null && \
  echo "⚠️  STALWART WAS FRESH-STARTED — data loss occurred"

# Bulwark
kubectl exec -n mail deploy/bulwark -c bulwark -- \
  cat /app/data/.fresh-started-at 2>/dev/null && \
  echo "⚠️  BULWARK WAS FRESH-STARTED — admin password reset, settings lost"
```

The init container also logs a `RESTORE-STATE-WARNING:` prefixed
message describing the reason. Grep pod logs to see why the
fresh-start happened:

```bash
kubectl logs -n mail -l app=stalwart-mail -c restore-state --tail=20 | grep RESTORE-STATE-WARNING
kubectl logs -n mail -l app=bulwark -c restore-state --tail=20 | grep RESTORE-STATE-WARNING
```

**Reasons logged**:
- `no-restic` — Stalwart RESTIC_REPOSITORY env var unset (no offsite backup configured)
- `allow-restore-not-set` — Stalwart's allow-restore annotation missing (operator did not approve restore)
- `restic-restore-failed` — restic call failed (network, auth, repo corruption)
- `restic-copy-failed` — restic succeeded but cp into PVC failed (disk full?)
- `unexpected-restic-layout` — restic snapshot didn't contain `var/lib/mail-stack/{stalwart,bulwark}/`
- `no-standby-no-restic` — Bulwark had neither standby data nor RESTIC_REPOSITORY
- `restic-no-bulwark-subdir` — restic snapshot was pre-A2.5 (no bulwark/ subtree)

**Follow-up (filed)**: platform-api should periodically check both
sentinels + surface a banner in the admin UI. Today the detection is
operator-pull (kubectl exec) rather than alert-push.

### 9. Bulwark restic-restore fallback (added 2026-05-25)

Pre-2026-05-25 Bulwark restore-state had ONLY the FAST PATH from
standby. If failover landed on a node with no standby data, Bulwark
fresh-started even when a valid restic snapshot existed.

Now Bulwark's restore-state init container mirrors Stalwart's
cascade:
1. SENTINEL exists (admin.json already on PVC) → skip
2. FAST PATH from `/standby-data/bulwark/` (with `.standby-complete`
   age gate)
3. **restic restore** from `RESTIC_REPOSITORY` (Secret
   `stalwart-snapshot-restic-repo`, shared with Stalwart)
4. Fresh-start (writes `.fresh-started-at` sentinel)

Init container image switched from `alpine:3.20` to
`mail-backup-tools` (which has restic + GNU date). Init runs once
so image size is irrelevant. Added an emptyDir `restore-tmp`
volume for restic's working dir.

## Diagnostic queries

### Current placement + state

```sql
SELECT mail_primary_node, mail_secondary_node, mail_tertiary_node,
       mail_active_node, mail_dr_state, mail_auto_failover_enabled,
       mail_failover_threshold_seconds, mail_last_failover_at
FROM system_settings WHERE id='system';
```

### Migration history

```sql
SELECT id, state, source_node, target_node, current_step,
       error_message, triggered_by, started_at, finished_at
FROM mail_migration_runs
ORDER BY started_at DESC
LIMIT 10;
```

### Pod placement vs configured active

```bash
kubectl get pod -n mail -l 'app in (stalwart-mail,bulwark)' -o wide
# Both pods should be on mail_active_node.
```

### Standby data freshness on each candidate

```bash
for node in $(kubectl get nodes -l insula.host/mail-standby=true -o jsonpath='{.items[*].metadata.name}'); do
  echo "=== $node ==="
  ssh root@$node "cat /var/lib/mail-stack-standby/.standby-complete 2>&1; du -sh /var/lib/mail-stack-standby/"
done
```

## Recovery procedures

### A. Force a stuck migration to complete

```bash
# 1. Identify the stuck pod / PVC
kubectl get pod -n mail
kubectl get pvc -n mail

# 2. Force-delete any stuck pods on dead source nodes
kubectl delete pod -n mail <pod> --grace-period=0 --force

# 3. Clear PVC finalizers (last resort)
kubectl patch pvc mail-stack-data -n mail -p '{"metadata":{"finalizers":null}}' --type=merge

# 4. Reset dr-state to degraded so dr-watcher retries
psql -c "UPDATE system_settings SET mail_dr_state='degraded' WHERE id='system'"
```

### B. Disable auto-failover during maintenance

```sql
UPDATE system_settings SET mail_auto_failover_enabled=false WHERE id='system';
```
Re-enable after maintenance window. Auto-failover does NOT trigger on
healthy/degraded transitions — only when an active node is observed
NotReady, so disabling is reversible at any time.

### C. Recover after a fresh-start (data was reset)

Triggered when both pods came up Ready with empty data after a
failover where standby was unavailable and restic restore failed
(or wasn't configured). The `.fresh-started-at` sentinel is
present + `RESTORE-STATE-WARNING:` is in pod logs.

**Step 1 — confirm the situation**:

```bash
kubectl exec -n mail deploy/stalwart-mail -c stalwart -- \
  cat /var/lib/stalwart/data/.fresh-started-at 2>/dev/null
kubectl exec -n mail deploy/bulwark -c bulwark -- \
  cat /app/data/.fresh-started-at 2>/dev/null
```

If both empty → false alarm (data is fine). If either prints a
timestamp + reason → data was reset in that subsystem.

**Step 2 — pick recovery source**. Options in order of preference:

| Source | When usable | Data age |
|---|---|---|
| Standby on another node | A3 DaemonSet still running there | Up to 5 min stale |
| Latest restic snapshot | Restic repo reachable now | Up to 2 min stale (cron cadence) |
| Older restic snapshot | When the latest already contains fresh-start state (because the snapshot CronJob ran AFTER the fresh-start) | Pre-incident, may be hours old |

**Step 3 — recovery from latest restic snapshot** (most common):

```bash
# 1. Confirm restic is reachable from the active node
ACTIVE=$(psql -tA -c "SELECT mail_active_node FROM system_settings WHERE id='system'")
kubectl exec -n platform $(kubectl get pod -n platform -l app=backup-rclone-shim --field-selector spec.nodeName=$ACTIVE -o jsonpath='{.items[0].metadata.name}') -- \
  wget -qO- --timeout=5 http://localhost:9000/ && echo "shim OK"

# 2. Scale down both Deployments
kubectl scale deploy stalwart-mail bulwark -n mail --replicas=0
kubectl wait --for=delete pod -n mail -l 'app in (stalwart-mail,bulwark)' --timeout=120s

# 3. Stamp allow-restore annotation on Stalwart's pod template
#    (Bulwark's restore-state will retry restic on its own)
kubectl patch deploy stalwart-mail -n mail --type=merge -p '
  {"spec":{"template":{"metadata":{"annotations":{"mail.platform/allow-restore":"true"}}}}}'

# 4. Delete CURRENT + admin.json sentinels so init containers see "empty PVC"
PVC=$(kubectl get pv $(kubectl get pvc mail-stack-data -n mail -o jsonpath='{.spec.volumeName}') -o jsonpath='{.spec.local.path}')
NODE=$(kubectl get pv $(kubectl get pvc mail-stack-data -n mail -o jsonpath='{.spec.volumeName}') -o jsonpath='{.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]}')
ssh root@$NODE "rm -f $PVC/stalwart/CURRENT $PVC/bulwark/admin/admin.json $PVC/stalwart/.fresh-started-at $PVC/bulwark/.fresh-started-at"

# 5. Scale back up — restore-state init containers will detect empty
#    PVC + allow-restore=true + RESTIC_REPOSITORY set → restic restore
kubectl scale deploy stalwart-mail bulwark -n mail --replicas=1

# 6. Watch the restore happen
kubectl logs -n mail -l app=stalwart-mail -c restore-state --tail=20 -f
kubectl logs -n mail -l app=bulwark -c restore-state --tail=20 -f

# 7. Verify CURRENT + admin.json present after main containers come up
kubectl exec -n mail deploy/stalwart-mail -c stalwart -- ls /var/lib/stalwart/data/CURRENT
kubectl exec -n mail deploy/bulwark -c bulwark -- ls /app/data/admin/admin.json
```

**Step 4 — recovery from an OLDER restic snapshot** (when fresh-start
data has been propagated into recent snapshots):

This is the case the operator hits when the original admin password
(or specific mail data) was lost BEFORE the operator noticed the
fresh-start, AND the snapshot CronJob already overwrote the
authoritative data with the fresh-start state.

```bash
# 1. List snapshots in the restic repo. Run from any Pod that has
#    the stalwart-snapshot-restic-repo Secret + restic binary.
kubectl run restic-list --restart=Never --rm -it \
  --image=ghcr.io/insulahq/insula/mail-backup-tools:latest \
  --env="$(kubectl get secret stalwart-snapshot-restic-repo -n mail -o json | jq -r '.data | to_entries[] | "\(.key)=\(.value | @base64d)"' | head -1)" \
  --env-from='secretRef:{name: stalwart-snapshot-restic-repo}' \
  --command -- restic snapshots --compact

# 2. Identify the snapshot from BEFORE the fresh-start (compare
#    snapshot timestamps vs the .fresh-started-at sentinel time)

# 3. Run a one-shot restic-restore Job with the chosen snapshot ID,
#    mounting mail-stack-data PVC. Same flow as Step 3 above but
#    use `restic restore <snapshot-id>` instead of `latest`.
```

**Step 5 — if all else fails**: nuke + accept fresh-start.
Operator resets admin passwords + asks users to recover from their
own client-side mail copies (IMAP IDLE clients often have local
caches).

### D. Decommission a standby node

```sql
UPDATE system_settings SET mail_secondary_node='new-node' WHERE id='system';
```
Platform-api's reconciler will:
- Remove `mail-standby=true` label from old node within 1 tick.
- Add label to new-node.
- DaemonSet pod on old node terminates; new pod spawns on new-node.
- Within 5 min the new node has fresh `.standby-complete`.

The old node's `/var/lib/mail-stack-standby/` directory remains on
disk — clean up manually: `ssh <old-node> "rm -rf /var/lib/mail-stack-standby/"`.

## Related

- `[[scripts/mail-stack-consolidate.sh]]` — one-time legacy-to-consolidated
  PVC migration.
- `[[docs/history/02-operations/MAIL_STACK_CONSOLIDATION.md]]` — PVC consolidation runbook.
- `[[backend/src/modules/mail-admin/migration.ts]]` — state machine.
- `[[backend/src/modules/mail-admin/dr-watcher.ts]]` — auto-failover trigger.
- `[[backend/src/modules/mail-admin/placement.ts]]` — placement reconciler
  (labels standby nodes, pins deployments).
- Project memory: `project_mail_ha_complete_2026_05_25` — full epic notes
  + bug-fix history.
