# Platform HA Mode (`Apply HA`)

Single-button operation that takes the platform from "any-node-failure causes outage" to "any single server can fail without outage". Reverse direction (`Revert to Local`) restores the simpler resource profile.

## What `Apply HA` actually does (M14)

| Component | Local tier | HA tier | Reversible? |
|---|---|---|---|
| Longhorn volumes (crowdsec + vmsingle metrics) | 1 replica | 3 replicas, spread across nodes | ✓ (extra replicas deleted) |
| CNPG **instance** PVCs | ≤2 replicas | **1** replica each | ✓ |
| Postgres CNPG `Cluster` `spec.instances` | 1 | 3 (sync replication) | ✓ (replicas removed; primary keeps data) |
| `admin-panel`, `tenant-panel`, `platform-api`, `oauth2-proxy`, `dex` Deployments | 1 replica | 3 replicas + `topologySpreadConstraints` (one per node) | ✓ (replica count) |
| Leader-elect operators: cert-manager (×3), Flux (×4), sealed-secrets, snapshot-controller, `cnpg-cloudnative-pg`, **`barman-cloud`** | 1 | 2 (leader + warm standby) | ✓ |

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
