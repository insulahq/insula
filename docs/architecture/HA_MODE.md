# Platform HA Mode (`Apply HA`)

Single-button operation that takes the platform from "any-node-failure causes outage" to "any single server can fail without outage". Reverse direction (`Revert to Local`) restores the simpler resource profile.

## What `Apply HA` actually does (M14)

| Component | Local tier | HA tier | Reversible? |
|---|---|---|---|
| Longhorn volumes (crowdsec + vmsingle metrics) | 1 replica | 3 replicas, spread across nodes | ✓ (extra replicas deleted) |
| CNPG **instance** PVCs | ≤2 replicas | **1** replica each | ✓ |
| Postgres CNPG `Cluster` `spec.instances` | 1 | 3 (sync replication) | ✓ (replicas removed; primary keeps data) |
| `admin-panel`, `tenant-panel`, `platform-api`, `oauth2-proxy`, `dex` Deployments | 1 replica | 3 replicas + `topologySpreadConstraints` (one per node) | ✓ (replica count) |
| Leader-elect operators: cert-manager (×3), Flux kustomize/helm/notification-controller, sealed-secrets, snapshot-controller, `cnpg-cloudnative-pg`, `longhorn-global-manager` (Longhorn 1.13+) | 1 | 2 (leader + warm standby) | ✓ |
| **`barman-cloud`** (CNPG backup plugin) | 1 | 2, **both active** (leader election off) | ✓ |
| Flux `source-controller` | 1 | **1** (`maxReplicas: 1`) | — |

> **One replica per server, in both tiers.** Every multi-replica platform
> workload carries a hard per-node rule (topology spread `DoNotSchedule` on
> the hostname, or `required` anti-affinity — CNPG instances), so a
> replacement for a down or cordoned server waits for it instead of doubling
> up. The rule binds only pods being scheduled; replicas that started while one
> server was up (fresh install, full-cluster restart, server replaced) are
> moved by platform-api's placement pass every 5 minutes — one replica per
> workload per pass, through the Eviction API, only once the workload is fully
> Ready and a Ready, schedulable node it fits on holds none of it, and never
> again within 30 minutes (`system-pod-placement/rebalance.ts`). HA never asks
> for more replicas or database instances than there are servers present. A
> one-server cluster keeps its copies on its one server. CI guard:
> `one-replica-per-server.test.ts`.

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

Every in-process timer starts on every platform-api replica.
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
not started a second time beside itself.

Every recurring timer is a recorded decision. `scheduler-lease-coverage.test.ts`
parses the backend source, finds each interval, each function that re-arms
itself with a timeout and each run-until-stopped loop, and fails until the
timer is either a leased job (`LEASED`) or listed with the reason it runs on
every replica (`EVERY_REPLICA`): it belongs to one connection or task in that
process, it feeds that process's own memory or gauges, its work is claimed
atomically (the nightly bundle scheduler's `last_fired_at` compare-and-set), or
it converges to a value every replica derives identically. Reasons that do
**not** qualify: "the notification has a dedupe key" (the key is checked by a
lookup, not a constraint, so replicas ticking together both send), and "the Job
name is deterministic" when the finished Job is removed before the next
replica's tick.

Two rules keep a long interval from becoming a long gap:

- **Liveness.** While a job runs, its lease covers the job's whole ttl — the
  work may outlive the process (a restic prune, a spawned Job), and nothing
  may start it again beside itself. When the run ends the lease is cut back to
  `LEASE_LIVENESS_MS` (10 min), and a keep-alive in the holding process extends
  it until the job's ttl has passed without a tick. A replica that dies between
  runs therefore frees a daily job's lease within ten minutes instead of
  holding it for 36 hours; the job then runs at the next replica's tick. A
  replica that dies mid-run keeps the lease for the full ttl, as before. Run
  locks (`release: true`) are written for their whole ttl.
- **The start-up run.** During a rollout the replaced process still holds the
  lease when the new one starts, so the new one's first tick is refused. A job
  whose own next tick is far away (ttl above nine minutes) is tried again
  through the lease `LEASED_STARTUP_DELAY_MS` (3 min) later, and once more just
  past the liveness window — the first covers a rollout, the second a holder
  that died. With other live replicas both are refused, as they should be. A
  start-up one-shot whose caller needs the result opts out
  (`startupRetry: false`).
- **One run per process.** A tick that finds its job still running in the same
  process is refused; the database cannot do that, since a holder's own claim
  always succeeds.

The upgrade reconciler is the one timer that takes its own per-tick claim
instead of a sticky lease (an upgrade restarts the replicas, so no replica may
own it); each pass additionally holds the run lock `platform-upgrade-pass`.

#### Work that something other than the timer starts (run lock)

The sticky lease decides which replica's **timer** runs a job. The same work is
also started by routes — a reconcile right after a change (a backup target
assignment, a trusted proxy range, a WAF exclusion, a mail hostname, *Apply
tier*), and the "run now" buttons — on whichever replica serves the request,
beside the timer's run on another replica or in the same process.

So that work takes a second lease, the job's run lock (`<job>-run`, released
when the run ends), through `runExclusive` in
`backend/src/shared/exclusive-run.ts`:

- the timer takes it inside its sticky lease and skips the tick when the lock
  is busy. The tick is skipped, not postponed — the job's next tick comes
  after its interval;
- a run started after a change waits for the run under way (`RUN_WAIT_MS`,
  30 s; the backup-target and mail-migration flows wait past the lock's 2-minute
  ttl) and then runs, so it always reads the change it was started for;
- a "run now" route waits the same 30 s and answers `409 JOB_ALREADY_RUNNING`
  if the job is still busy.

A run renews its lock while it lasts, for 30 minutes at most
(`RUN_LOCK_MAX_HOLD_MS`; the automatic archive/delete sweep, which works through
its tenants one at a time, passes 24 hours).

#### A run that never returns

A run that hangs — it waits on something that never answers — used to stop its
job for good: every later tick was refused in that process, its lease was
renewed for ever, and a timer that re-arms itself after its tick never did. On
a single-replica cluster the job stayed dead until the pod restarted.

Every leased run now has a longest hold (`maxHoldMs` in
`backend/src/shared/scheduler-lease.ts`): four of the job's ttls, twelve hours
at least, for a sticky lease; the 30 minutes above for a run lock. Past it the
helper gives the run up:

- the job is free again, in this process and (a run lock is released) on every
  other replica — its next tick starts it afresh;
- the caller gets `LeasedRunAbandonedError`;
- it is logged, and the admins get a "Background jobs" notification naming the
  job, at most once an hour per job.

The run given up may still be pending; whatever it returns later is logged and
dropped. The lease writes that follow a run (the release, the cut-back) are
waited for 60 s at most — a database that stops answering at that moment must
not leave the job "running" in the process either. The hold is far above any honest run on purpose: a run given up while
it is merely slow is joined by a second one. A job that bounds its own work and
must never be started beside itself passes `maxHoldMs: Infinity`.

#### One change to a tenant at a time (tenant lock)

A storage operation claims its tenant by writing `storage_lifecycle_state`
after checking that it is idle — two steps — and a delete claimed nothing. An
operator and the automatic archive/delete sweep could so reach one tenant at
once: two archives of it, a delete beside a restore, two deletes.

Everything that starts an operation on a tenant (resize, the restores, suspend,
resume, archive, filesystem check, a move to another node) and everything that
deletes one (the tenant route, bulk delete, the sweep) holds that tenant's run
lock, `tenant:<id>` (`backend/src/modules/tenant-lifecycle/tenant-lock.ts`),
while it checks and claims — a delete, a suspend and a resume for as long as
they run, which is why this lock's longest hold is six hours
(`TENANT_LOCK_MAX_HOLD_MS`) and not the run lock's half hour: giving a delete
up while it is merely slow would let an archive start on a half-deleted
tenant. A caller waits 15 s for the lock and then answers `409 TENANT_BUSY`.
The lock is not reentrant; nothing that holds it calls another holder for the
same tenant.

Inside the lock a caller sees the tenant as it is. The sweep reads its list of
due tenants once and may reach the last of them hours later, so its archive and
its delete each check again, under the lock, that the tenant is still due and
has not been taken out of the automation meanwhile (`NO_LONGER_DUE` — left
alone, not a failure).

#### An archive whose process is gone (liveness lock)

The tenant lock covers the start of an operation. The operation itself runs
detached, in the API process, after the request has been answered — and a
deploy, a crash or a lost node ends that process in the middle. The row then
reads "snapshotting" with nothing behind it.

A resize, a restore, a filesystem check and an archive each hold a second run
lock for as long as a process is working on them, `storage-op:<operation id>`
(`opLockJob`, `backend/src/modules/storage-lifecycle/op-lock.ts`), renewed like
any run lock and given up after six hours. Every starter takes it before it
answers (`beginOp`); an operation whose lock cannot be taken is failed at once
and its tenant released (`503 STORAGE_OP_NOT_STARTED`) — one without a lock
would be nobody's, neither running nor ever picked up.

A leased two-minute tick (`storage-op-pick-up`, `interrupted-ops.ts`) reads
"gone" from that lock:

- the lock's row is there and lapsed a minute or more ago — a process that
  ends its operation deletes the row, one that dies leaves it to lapse
  (a graceful shutdown keeps the locks of work still running, so those lapse
  too);
- no row at all, three minutes or more after the operation began, and the
  operation younger than six hours. Every operation this release starts runs
  under its lock, so one without is an earlier release's, or one whose own
  ending failed. An earlier release's process may still be alive during a
  rolling upgrade, so such an operation is touched only when every
  `app=platform-api` pod that exists — on its way out or not — runs the image
  this process runs. When that cannot be told (not running as a pod, list
  unreadable) it is left alone.

Such an operation is started again under its lock (`resumeOperation`), so two
watchdogs, or a watchdog and a holder that was only slow, cannot both run it.
Every runner can be run a second time from the top, whichever step the first
run died in; what a second run must know is read from the cluster where it can
be (is the claim the new size, is it bound to the retained volume, is the
tenant archived, is the operation's state `unquiescing`) and written on the
operation's `params` where it cannot (replica counts, storage class, the
volume set aside, a filesystem check's result). Helper Jobs carry names a
second run can find; one still running is waited for, never doubled.

A suspend and a resume do not run detached: they hold the **tenant's** lock for
as long as they take, and that lock is what is read for them. One cut off is
finished under that lock (`resumeTransitionOp`): the workloads are scaled from
the replica counts written down, and the cascades go through `applyOnceSince`
like an archive's. It is not ended and asked for again, because a suspend cut
off among its cascades has stamped the tenant suspended — a second suspend is
refused — with the ingress still up. The operator's "do not notify the tenant"
is written on the operation's `params`, since the process that finishes it was
not asked.

An operation picked up three times (`OP_MAX_RESUMES`), or one whose row does
not say how to run it again, is ended at once by the same function the age
rule uses (`endAbandonedOperation`), which takes the operation's lock, marks
it failed first, removes the Jobs and attaches that hold its volume, starts
the workloads from the replica counts written down, and notifies the admins.

The workloads are **not** started when the tenant's volume does not hold its
files (`whyWorkloadsStayStopped`): a shrink between deleting the old volume
and finishing the restore into the new one, a restore from a retained volume
with the claim deleted and not yet made again. The same rule applies to those
operations' own failure paths. "Not started" is kept by leaving
`tenants.active_storage_op_id` on the failed operation: the watchdog's
leftover leg, the workload-health reconciler and the dashboards all skip a
tenant that points at an operation, so none of them "heals" the stopped
workloads onto an empty volume. **Reset to idle** (`clearFailedStorageState`) releases it.

A claim carries `awaitingLock: true` in the operation's `params` until its run
has the lock. One that still reads true never began — its starter told its
caller so — and is withdrawn by the pick-up, never run.

Cascades (`applyArchived`, `applyRestored`, `applySuspended`, `applyActive`) of
an operation picked up again go
through `applyOnceSince` (`tenant-lifecycle/cascades.ts`): the first run's own
transition is found by tenant, kind and the operation's start. Finished — any
way — nothing is run. Still `running`, its process is gone, and the dispatcher
finishes it (`resumeTransitionId`): hooks that ended are skipped, the one that
was running and the pending ones are run, a failed one stays the retry
scheduler's. The tenant's status is not the test — it is stamped by one hook
among several.

**Transitions have the same lock.** The dispatcher runs a transition's hooks
under `lifecycle-transition:<transition id>`
(`tenant-lifecycle/registry/transition-lock.ts`). A transition that reads
`running` with that lock lapsed — or with none, an earlier release's, once
every API pod is this release — was cut off between two hooks, and nothing
retried the rest: the retry scheduler takes `failed` rows only. The lifecycle
tick (`lifecycle-hook-retry`, two minutes) finishes those first
(`interrupted-transitions.ts`), under the tenant's lock:

- not one whose tenant a storage operation in flight owns — that operation
  finishes its own cascades when it is picked up;
- a **delete** is taken to its end through the tenant delete's own body
  (`finishInterruptedDelete`): remaining hooks, namespace, row. `applyDeleted`
  holds the transition open (`holdOpen`, `endTransition`) until the row is
  dropped, so a delete cut off after its last hook still reads `running` and is
  found. When the dispatcher ran nothing because another process holds the
  transition, nothing is dropped either — that process's hooks still read the
  tenant's rows. Only `to_status = 'deleted'` without `detail.preservedTenant`
  is a delete of the tenant: a decommission (`runDeprovision`) dispatches a
  `deleted` transition and keeps the row, and is closed, never finished;
- one the tenant has moved past (any later transition), one that began inside
  a storage operation which has since ended `failed` (given up, cancelled,
  abandoned), one older than six hours, one picked up three times, and one
  whose tenant is gone (a delete excepted) is **closed**: `failed_partial`,
  its unfinished hooks `failed` with the reason and no retry. Finishing a
  suspend after the operator resumed the tenant would half suspend it again.

The dispatcher writes `suppressTenantNotification` into the transition's
`detail` and reads it back when it finishes one; it also counts there, under
the transition's lock, how often a transition was finished (`resumes`) — a
look that found the lock held has not run it. A hook the *retry scheduler*
was running when its process died stays `running` under a transition that is
no longer running; `requeueInterruptedRetries` hands it back after thirty
minutes.

A lapsed lock does not prove a dead process: one paused for minutes — a
stalled VM, a database out of reach — looks the same from outside, and wakes
up in the middle of its run after another replica has taken the operation
over. So a runner asks before every step that writes or deletes whether the
operation is still its own (`operationIsMine`) and stops where it is when it
is not — without marking the operation failed and without bringing the
workloads back, both of which would happen under its successor's feet. "Its
own" is two things: the lock's row carries this process's name, **and** the
operation has not ended. The second is not implied by the first: a run renews
its lock by writing the row again when it is gone, so a process that wakes
after its successor has finished and let go would simply take the lock back.
It is also what makes an operator's cancel stop the run. What stays open is a
stall between one such question and the action after it.

The fifteen-minute watchdog removes run locks that lapsed more than a day ago
(`forgetDeadRunLocks`) — a tenant's or an operation's, left by a process that
died holding one. Nothing else releases them.

The age rule (six hours without an end; thirty minutes for a move) never ends
an operation whose lock is held: one picked up late is working, whatever its
age. It is what is left for a move, for an operation given up as hung, and for
an operation without a lock while an API process of another release exists.

#### The guard

`scheduler-lease-callers.test.ts` parses the source for every call, outside a
lease's own file, of a function a sticky lease's callback calls — read through
functions private to the lease's file, which is where seven of 64 jobs do all
their work. Each such call must take the run lock (`'run-lock'`, verified —
and the timer must take it too) or carry the reason an overlap is harmless.
Two tables name a function once instead of once per caller: `READS`, and
`BESIDE_ANY_CALLER` for a function that brings one item to its stored state.
Not followed: what an entry point from another file does inside; its callers
are what is checked.

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
