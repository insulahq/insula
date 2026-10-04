# Platform HA Mode (`Apply HA`)

Single-button operation that takes the platform from "any-node-failure causes outage" to "any single server can fail without outage". Reverse direction (`Revert to Local`) restores the simpler resource profile.

## What `Apply HA` actually does (M14)

| Component | Local tier | HA tier | Reversible? |
|---|---|---|---|
| Longhorn volumes (crowdsec + vmsingle metrics) | 1 replica | 3 replicas, spread across nodes | ✓ (extra replicas deleted) |
| CNPG **instance** PVCs | ≤2 replicas | **1** replica each | ✓ |
| Postgres CNPG `Cluster` `spec.instances` | 1 | 3 (sync replication) | ✓ (replicas removed; primary keeps data) |
| `admin-panel`, `tenant-panel`, `platform-api`, `oauth2-proxy`, `dex` Deployments | 1 replica | 3 replicas + `topologySpreadConstraints` (one per node) | ✓ (replica count) |
| Leader-elect operators: cert-manager (×3), Flux kustomize/helm/notification-controller, sealed-secrets, snapshot-controller, `cnpg-cloudnative-pg` | 1 | 2 (leader + warm standby) | ✓ |
| **`barman-cloud`** (CNPG backup plugin) | 1 | 2, **both active** (leader election off) | ✓ |
| Flux `source-controller` | 1 | **1** (`maxReplicas: 1`) | — |

> **CNPG instance PVCs go DOWN in HA, not up.** Postgres streaming replication
> already keeps three copies; giving each instance PVC three Longhorn replicas
> as well would store nine. Disk-failure tolerance comes from CNPG instance
> failover.

> **`barman-cloud` is in the leader-elect tier for a reason.** It is the CNPG
> backup plugin, and the CNPG operator **refuses to reconcile a Cluster whose
> plugin it cannot reach** — including refusing to promote a new primary. It
> shipped at `replicas: 1`, so during the 2026-09-11 drill the node holding it
> died and took the platform database and the whole management API down for
> ~6.5 minutes, clearing only when Kubernetes' 300s eviction moved the pod.
> Scaling an operator without its plugin is not HA.
>
> Its two replicas both serve. Upstream registers the CNPG-I gRPC server as a
> leader-only runnable, so under `--leader-elect` the second replica never
> opened `:9090` — permanently 0/1 Ready with a readiness-probe Warning every
> 10 s. `k8s/base/cnpg-system/kustomization.yaml` sets `--leader-elect=false`
> (guarded by a JSON6902 `test` op): the gRPC hooks are request/response and
> the one controller (ObjectStore → Role rules) converges to the same state
> from either replica.

> **Flux `source-controller` is pinned to one replica.** It stores fetched
> artifacts on the pod's own disk and serves them only from the leader; Flux
> does not support scaling it. A standby was 0/1 Ready forever and would start
> with no artifacts on takeover. On node loss Kubernetes reschedules it;
> applied workloads keep running, only new git changes wait.

### platform-api scheduled jobs (scheduler lease)

Every in-process `setInterval` scheduler starts on every platform-api replica.
A job that must not run concurrently claims a sticky lease in
`platform_settings` (`scheduler-lease:<job>` → `{"holder","until"}`) via
`withSchedulerLease` (`backend/src/shared/scheduler-lease.ts`): the holder keeps
running every tick, the others skip, and a lapsed lease (ttl ≈ 1.5× the
interval, DB `now()` only) is taken over by the next replica to tick. Long runs
renew it; `release: true` turns it into a run lock (the restic retention sweep
uses both: a sticky schedule owner plus a run lock shared with the manual
"Run sweep" button, which returns `409 RETENTION_SWEEP_RUNNING` while one is in
flight). Graceful shutdown releases every lease the process holds, so a rollout
does not stall 6- and 24-hour jobs for a full ttl — except the lease of a job
still running in that process, which expires as after a crash, so the job is
not started a second time beside itself. The covered jobs are listed
in `scheduler-lease-coverage.test.ts`; the nightly bundle scheduler is already
safe through its `last_fired_at` compare-and-set.

What `Apply HA` does NOT do:
- Per-tenant client workloads (separate per-tenant storage tier — see
  `NODE_OUTAGE_RESILIENCE.md` §2 for how a tenant degrades on node loss)
- **The mail stack.** Stalwart and Bulwark are **Deployments** (not a
  StatefulSet) on a **`local-path`** PVC (not Longhorn), so the volume cannot
  rebind to another node. Failover is the restore-based state machine in
  `MAIL_HA_FAILOVER.md` — measured at **~4 min** on staging, not 30-60s. An
  earlier version of this table described a StatefulSet recovering via
  "Longhorn HA volume rebind"; both halves were wrong.
- Redis was removed in M14 — replaced by per-pod in-memory LRU. No HA concern.
- ingress-nginx — already a DaemonSet (one pod per node)
- etcd — already 3-server quorum from bootstrap

## Pre-conditions

Apply HA requires:
- ≥3 Ready server nodes (the `recommendedTier` calculation enforces this)
- `cm/platform-operator-recipient` exists (used by backup CronJobs)
- CNPG operator running (`kubectl get deploy -n cnpg-system cnpg-controller-manager`)

The recommendation banner only shows when `recommendedTier=ha && systemTier=local && !pinnedByAdmin`. The Apply HA button is disabled when the cluster doesn't meet the threshold.

## Flow

```
┌─────────────────┐
│ Operator clicks │
│  "Apply HA"     │
└────────┬────────┘
         │
         ▼ confirmation modal lists every change
         │
         ▼ super_admin → PATCH /api/v1/admin/platform-storage-policy
         │
         ▼ backend applyPolicy() runs three patch loops:
         │   1. Longhorn volumes (1→3 replicas per CR)
         │   2. Stateless Deployments (replicas + topologySpread)
         │   3. CNPG Cluster (instances 1→3)
         │
         ▼ each loop is independent; partial failure is reported
         │   not aborted (so 1 LH + 0 deploys + 1 CNPG patched
         │   shows up clearly in the result)
         │
         ▼ audit_logs row written with before/after + per-resource patch
         │
         ▼ UI receives ApplyPlatformStoragePolicyResponse:
             { policy, patches[], deployments[], cnpgClusters[] }
```

## Reverse (`Revert to Local`)

Same three loops in reverse:
- Longhorn volumes 3→1 replica (extra copies deleted)
- Stateless Deployments 3→2 replicas (topologySpread retained — harmless at 2)
- CNPG Cluster instances 3→1 (replicas removed; primary keeps all data)

Reverting does NOT lose data anywhere. CNPG drops the standby pods cleanly; Longhorn deletes extra replicas after rebuilding-down.

## Failure modes

| Scenario | Apply HA result | Recovery |
|---|---|---|
| `cluster.postgres` not yet reconciled (Flux still applying) | `cnpgClusters[0].error="cluster CR not found (Flux still reconciling?)"` | Wait + retry |
| Operator clicks Apply HA on a 2-server cluster | Frontend disables the button (`recommendedTier !== 'ha'`) | Wait until 3rd server joins |
| Longhorn patch fails (e.g. volume currently detaching) | `patches[i].error="..."`, other components still patched | Re-click Apply HA after Longhorn settles |
| CNPG instance scale-up fails (insufficient resources) | `cnpgClusters[0].error="..."`, primary unaffected | Operator must address resource issue |
| `kubectl patch deploy admin-panel` fails (RBAC) | `deployments[i].error="forbidden"` | Check ServiceAccount permissions |

## Control-plane leader election

Every k3s server writes `/etc/rancher/k3s/config.yaml.d/60-leader-election.yaml`
(`bootstrap.sh:configure_control_plane_resilience`; existing nodes are converged by
host-migration `2026.9.31/0001-k3s-leader-election`):

| Setting | Kubernetes default | Here |
|---|---|---|
| `leader-elect-lease-duration` | 15s | **45s** |
| `leader-elect-renew-deadline` | 10s | **30s** |
| `leader-elect-retry-period` | 2s | **5s** |

Applied to `kube-controller-manager`, `kube-scheduler` and the embedded cloud-controller-manager.

**Why:** losing leadership exits the whole k3s process, taking the control plane with it. A
storage stall longer than the *renew deadline* is enough to trigger that, and a 10s deadline is
shorter than stalls this platform has actually seen. Raising it turns such a stall into a latency
blip.

**HA cost — read this before tuning it back:** a genuinely dead server is taken over after
**~45s instead of ~15s**. Workloads keep serving throughout either way; what is delayed is the
surviving server picking up controller-manager and scheduler duties.

**Verify against the Lease, never the config file.** k3s logs `Unknown flag … in config.yaml,
skipping` and carries on if a key name is wrong, leaving that component on the default:

```bash
kubectl -n kube-system get lease kube-controller-manager \
  -o jsonpath='{.spec.leaseDurationSeconds}'   # expect 45
```

The cloud-controller-manager key is `kube-cloud-controller-manager-arg`, **not**
`cloud-controller-manager-arg` — the latter is silently ignored.

## Replica/instance field ownership

Two cooperating mechanisms keep Apply HA's imperative scale
operations from being reverted by Flux SSA:

1. **Stateless Deployments** (admin-panel, tenant-panel, platform-
   api, oauth2-proxy, dex) have NO `replicas:` field in their
   manifests. Flux doesn't claim ownership of the field. The
   platform-storage-policy reconciler writes it via the `/scale`
   subresource and SSA leaves it alone.
   - Fresh clusters land at K8s default = 1 replica per Deployment.
2. **CNPG `Cluster.spec.instances`** is required by the CRD so
   it can't be omitted. Instead, the Flux Kustomization for
   `./k8s/overlays/${env}` includes a `spec.patches` block that
   strips `spec.instances` from the manifest before SSA. CNPG
   operator defaults the field to 1 on apply. The reconciler
   then patches to 3 (or back to 1) without conflict.
   - Bootstrap.sh applies this Kustomization shape on first install.

Consequence: HA recommendation banner appears once the cluster
has ≥3 ready servers. Operator clicks Apply HA → 3 replicas + 3
CNPG instances, persists indefinitely. Apply Local → 2 replicas
+ 1 CNPG instance, persists.

## Smoke tests covering this

- **Test 8** — every stateless Deployment has ≥3 ready replicas across ≥2 nodes (when tier=ha)
- **Test 9** — CNPG Cluster reports `readyInstances === spec.instances`

Run via `make smoke` after any Apply HA / Revert to Local action.

## Why not also do stalwart-mail / redis / k3s

- **stalwart-mail**: clustering across pods isn't validated for our deployment. Active-active over RWX risks mailbox state corruption. The stack is a single replica on a node-pinned `local-path` PVC, so recovery is the restore-based failover in `MAIL_HA_FAILOVER.md` (measured ~4 min on staging, with a ~3 min failback), NOT a volume rebind. Revisit when stalwart >0.10 cluster mode is mature.
- **redis**: removed in M14. The previous use was a per-pod TTL cache; `lru-cache` in-memory replaces it. No HA concern.
- **k3s control plane**: already 3-server etcd quorum from bootstrap. No further action.

## Audit trail

Every Apply HA / Revert to Local writes an `audit_logs` row with:
- `action_type=update`
- `resource_type=platform_storage_policy`
- `actor_id` = the user who clicked
- `changes` = full before/after snapshot including per-resource patch results

Query: `SELECT actor_id, changes, created_at FROM audit_logs WHERE resource_type='platform_storage_policy' ORDER BY created_at DESC LIMIT 5;`
