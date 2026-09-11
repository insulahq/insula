# Node-outage resilience — model, findings, and work tracker

> **Status:** in progress. Started 2026-09-11 after a four-phase destructive drill on
> staging in HA mode. This document is the single place where the outage model, the
> measured behaviour, and the remaining work live. Update it as items land.

Scope: what happens to the platform and to tenants when a node is lost — temporarily or
permanently — how the operator finds out, and how they recover. Total-cluster loss is
covered at the end.

---

## 1. Measured baseline (staging, 3 servers + 1 worker, HA mode)

Four drills, each killing k3s on a live node and restoring it afterwards.

| Event | Measured |
|---|---|
| k3s killed → Kubernetes `NotReady` | ≤ 69 s |
| → platform node-health detects | **4 m 20 s** (5-min reconciler tick) |
| Management API unavailable after losing the DB-primary node | **~3 min** |
| Management API + DB unavailable when the dead node held `barman-cloud` | **~6.5 min** |
| Mail auto-failover, configured (death → serving elsewhere) | **~4 min** |
| Mail failback to primary | **~3 min** |
| Mail outage with failover unconfigured + manual recovery | **~11.5 min** |

Data survived every path: a canary planted in the mail store was recovered intact through
a restic cold restore, an automatic failover, and a failback.

---

## 2. The tenant degradation model

A tenant's availability after a node loss is decided almost entirely by its
**storage tier**, because the tier decides whether the tenant is pinned to one node.

### 2.1 How tenants are placed

- **`storage_tier = 'local'` (the default).** The Longhorn volume gets
  `numberOfReplicas = 1`, and the tenant **must** be pinned to a node
  (`tenants.node_name`); provisioning auto-picks one if the operator chose "Auto".
  The single replica exists only there, so workloads are pinned to match.
- **`storage_tier = 'ha'`.** `numberOfReplicas = 2`, `node_name` stays null, and
  `dataLocality=best-effort` lets the primary drift. The scheduler places freely.

> Note the asymmetry with the platform's own volumes: Apply HA moves *system* volumes to
> 3 replicas, but a tenant on the HA tier gets **2**. One node loss therefore leaves an
> HA tenant with a single surviving replica — serving, but with no redundancy left.

### 2.2 Degradation matrix

| Tenant tier | Which node died | Storage | Workloads | Verdict |
|---|---|---|---|---|
| `local`, pinned to the dead node | its own | **faulted** — only replica gone | **unschedulable** — pinned | **Down** |
| `local`, pinned elsewhere | another | fine | fine | Healthy |
| `ha` | any one | **degraded** — 1 of 2 replicas | reschedules | **Degraded**, self-healing |
| any tier | the **mail active node** | — | — | **Mail degraded** (see 2.3) |

### 2.3 Mail is a separate, cross-cutting axis

Mail is a single Stalwart instance on one node. When that node dies, **every tenant with
mailboxes loses mail at once**, regardless of its storage tier or pin. So a tenant can be:

- **Partially degraded** — sites/databases down (pinned to the dead node) but mail fine,
  or mail down but sites fine.
- **Fully degraded** — pinned to the dead node *and* that node was the mail active node.

These are independent conditions and must be reported independently; collapsing them into
one status hides which half the operator can actually fix.

### 2.4 Findings → recovery actions

The recovery primitives already exist; what is missing is the mapping and the surface.

| Finding | Detect via | Recovery action | Exists today |
|---|---|---|---|
| `workloads_pinned_to_down_node` | `tenants.node_name` = a NotReady node | Re-pin the tenant to a live node | yes — the drain flow's `tenantPlacement` already re-pins workloads + volumes + DB row |
| `volume_last_replica_on_down_node` | Longhorn replica set for the tenant's volumes | Wait for node return, or restore from the latest tenant bundle | yes — `dr-recover` restores a tenant from a bundle |
| `volume_degraded_rebuilding` | Longhorn `robustness=degraded` | None — informational, self-heals | n/a |
| `mail_unavailable` | mail active node NotReady / `mail/health` unhealthy | Mail failover, then failback | yes — `/admin/mail/failover`, `/admin/mail/failback` |
| `namespace_resources_missing` | existing namespace-integrity audit | Repair | yes — `namespace-integrity` |

`buildDrainImpact` already computes most of the blast radius (per-tenant workloads, PVCs,
last-replica detection) and **already works against a dead node** — it is simply not
reachable outside the planned-drain modal.

---

## 3. Failback: what happens when the dead node comes back

Two mechanisms behave very differently, and only one of them is clean.

### 3.1 Longhorn (tenant volumes) — clean

Verified by deleting a server node and re-adding it. The Longhorn `Node` CR is reused, the
node returns `Ready`, and replicas resume on it. A stale replica is rebuilt from the
healthy copy rather than promoted, so there is **no split-brain risk** and no operator
action is required.

One caveat: the Longhorn `Node` CR for a deleted node is **not** removed when the
Kubernetes node is deleted, so it lingers as a stale object until the node returns.

### 3.2 Mail (local-path PVC) — leaks a full copy of the mail store, every time

The mail stack deliberately uses `local-path`, so the PVC does not migrate. A failover
**deletes** the PVC object and creates a fresh one on the target node. The old PVC's
*directory* stays on the source node's disk forever.

Observed on staging after a day of drills — six orphaned directories across three nodes
alongside the one live PVC:

```
node-a   4.0K  …/pvc-<id-1>_mail_mail-stack-data     (orphan)
node-a   146M  …/pvc-<id-2>_mail_mail-stack-data     (LIVE)
node-a   7.6M  …/pvc-<id-3>_mail_mail-stack-data     (orphan)
node-c   6.7M  …/pvc-<id-4>_mail_mail-stack-data     (orphan)
node-c   5.8M  …/pvc-<id-5>_mail_mail-stack-data     (orphan)
node-c   1.4M  …/pvc-<id-6>_mail_mail-stack-data     (orphan)
node-c   1.7M  …/pvc-<id-7>_mail_mail-stack-data     (orphan)
```

Nothing reaps these. The `mail-standby-janitor` DaemonSet only scans for
`mail-stack-standby.deelected-*` directories (confirmed: `found=0 cleaned=0` while the
seven directories above existed), and the `orphaned-volumes` module classifies *PV
objects* for deleted tenants — neither looks at local-path host directories whose PV has
already been deleted.

**Consequence:** on a real mail store, every failover permanently consumes another full
copy of the mailbox data on the node it left, until an operator deletes it by hand. Two
failovers on a 40 GB store leak 80 GB. Disk pressure then triggers eviction, which is
itself a node-outage cause.

**No correctness risk** — the PV is deleted, so the stale directory can never be
re-mounted or served. This is a capacity bug, not a split-brain bug.

### 3.3 The other failback gap: standby data is staged on the wrong nodes

The placement reconciler labels whatever is configured as `secondary` + `tertiary`. After
a failover the active node is usually one of those, so it replicates from itself, while
the **primary — the failback target — carries no fresh standby data at all**. On staging
the primary's standby sentinel was two months old, so failback correctly rejected it via
the max-age gate and fell back to the slower restic path.

Standby nodes should be derived as *"viable candidates that are not currently active"*,
recomputed after every placement change.

---

## 4. Operator-visibility findings

Ranked by consequence. Detail and evidence for each is in the drill report.

| # | Finding | Severity |
|---|---|---|
| 1 | `barman-cloud` is `replicas=1`, has no spread/PDB, is **not** in Apply-HA's scope, and gates **all** CNPG reconciliation — losing its node means no primary failover, so DB + management API stay down until Kubernetes' 300 s eviction | Critical |
| 2 | `/admin/status` never checks node readiness, so the only globally-mounted banner stays green through every outage | Critical |
| 3 | A dead node keeps its ingress DNS records, so a share of all traffic blackholes | High — *accepted, manual* (see §6) |
| 4 | Mail auto-failover defaults off, and `dr-watcher` returns immediately when off — no degraded state, no alert, no action | High |
| 5 | Operator-triggered failover wedges for the full 5-min snapshot timeout on a dead source node; the automatic path correctly skips it | High |
| 6 | Every Bulwark restore reports data loss: `cp -a` as UID 1000 cannot preserve times on the root-owned PVC root, exits non-zero **after copying every file**, and writes a fresh-start sentinel. Nothing reads that sentinel (0 backend references vs 4 for Stalwart) | High |
| 7 | Node-down notifications: severity mismatch (`flagged CRITICAL` dispatched as `info`), duplicated, and the title carries no node name | Medium |
| 8 | Detection lags ~4 m 20 s; an API restart caused by the outage resets the reconciler timer | Medium |
| 9 | A NotReady node still renders live-looking CPU/memory/pod counts labelled "just now", plus `ingress: all` | Medium |
| 10 | Standby data staged on the active node instead of the failback target (§3.3) | Medium |
| 11 | Specialised banners (mail, backup, DNS drift, namespace integrity) mount only on their own deep pages | Low |
| 12 | Decommission residue: stale Longhorn `Node` CR, mail placement still naming a deleted node, orphaned mail PVC directories (§3.2) | Low |

---

## 5. Total-cluster loss

Backup coverage is layered and, when checked, current: etcd snapshots hourly offsite and
12-hourly local, Postgres base backup daily plus continuous WAL archiving, cluster-state
and secrets bundles daily, mail restic every 30 min, Longhorn volume backups daily and
weekly. `DISASTER_RECOVERY.md`, `dr-restore.sh` and `dr-drill.sh` (three fidelity modes up
to a real recovery onto a throwaway VM) all exist.

**The gap was proof, not machinery** — partly closed 2026-09-11. `DR_DRILL_LOG.md` now
exists with an exact, repeatable procedure and two recorded runs: `validate` (1 s) and
`dind` (30 s), the latter confirming the bundle decrypts, the production restore library
processes it, and every restored Secret passes a **server-side dry-run against a live
cluster**. A quarterly/annual cadence is written down.

**Still open:** the `bootstrap` mode — a real recovery onto a throwaway VM — has never
been run, so the ≤ 2 h RTO remains an aspiration rather than an observation. And the
operator age key on staging currently lives on a cluster node, i.e. on the machine that a
total-cluster-loss scenario assumes is gone; an off-cluster copy needs confirming.

Everything is encrypted to the operator age key. If that key is lost, none of it is
recoverable — the one single point of failure that replication cannot address.

---

## 6. Decisions taken

- **DNS is not automated.** The platform does not own DNS. A dead node's records stay
  published and removing them is a **manual operator action**. Document it in the outage
  runbook rather than building withdrawal logic.
- **Mail failover is never auto-enabled.** Turning it on is a deliberate operator
  decision. Instead, **warn** when the platform is in HA mode while mail failover is off
  or has no secondary/tertiary configured.

---

## 7. Work tracker

| ID | Item | State |
|---|---|---|
| A1 | Tenant degradation model (§2) | done |
| A2 | Failback with a returning node (§3) | done |
| A3 | This document | done |
| B1 | `barman-cloud` + any control-plane singleton into HA scope | **done** |
| B2 | Node-aware platform health | **done** |
| B3 | Global node-outage banner + affected-tenants drill-down | **done** |
| B4 | Tenant health column + degraded modal with action items | **done** |
| B5 | Warn when mail failover is unconfigured in HA mode | **done** |
| B6 | Skip snapshotting on a dead source in operator-triggered failover | **done** |
| B7 | Fix Bulwark false restore-failure; read both sentinels | **done** |
| B8 | Node-outage notification severity / dedupe / naming | **done** |
| B9 | Faster node-readiness detection | **done** |
| B10 | Stop rendering stale metrics for NotReady nodes | **done** |
| B11 | Derive standby nodes from non-active candidates | **done** |
| B12 | Decommission residue: Longhorn node CR, placement refs, orphaned mail PVC dirs | **done** |
| D1 | Reap orphaned mail-store directories left by failovers (§3.2) | **done** |
| D3 | Auto re-pin HA-tier tenants off a downed node | **done** |
| D2 | Restoration wizard for degraded tenants | **done** |
| C1 | Exact DR drill procedure, executed and recorded | **done** (validate + dind run and logged; `bootstrap` RTO still unmeasured) |
| C2 | Correct the runbooks (see below) | **done** |
| G1 | API survives a DB-primary failover (§8.1) | **done** |
| G2 | Failback review after a node returns (§8.2) | **done** |
| G3 | Manual DNS action surfaced during an outage (§8.3) | **done** |
| G4 | Auto re-pin verified on a real HA-tier tenant | pending — needs an `ha`-tier tenant on staging |
| G5 | Mail-failover-not-configured banner verified rendering | pending |
| G6 | Re-pin driven end to end through the recovery wizard | pending |
| G7 | Worker-node loss drilled | pending |

### Known doc inaccuracies to fix under C2

- `HA_MODE.md` describes the mail stack as a **StatefulSet** whose failover is handled by
  "Longhorn HA volume rebind (~30–60 s)". Both halves are wrong: the mail stack is
  Deployments on a `local-path` PVC, and failover is the restore-based state machine in
  `MAIL_HA_FAILOVER.md` taking ~4 min.
- `MAIL_HA_FAILOVER.md` says the standby DaemonSet pre-stages data on `mailPrimaryNode`
  after a failover. It does not — labels follow `secondary` + `tertiary` (§3.3).
- `MAIL_HA_FAILOVER.md` lists a filed follow-up for platform-api to detect the fresh-start
  sentinels and banner them. Still not done, and the Bulwark sentinel is unreadable noise
  until B7 lands.
- `NODE_HEALTH_MONITORING.md` does not mention that a dead node's row keeps rendering
  stale metrics, nor the detection latency.
- `DISASTER_RECOVERY.md` RTO/RPO table has never been filled in.


## 8. Gaps closed after the first drill round (2026-09-11)

Answering "is every failover scenario except total cluster loss now either automated or
visible?" honestly meant saying **no** first. These are the gaps that answer covered.

### 8.1 The management API died with its database (G1)

The drill recorded the API unreachable for ~3 minutes after the node carrying the Postgres
primary went NotReady, and the first explanation — "it waits for the DB" — was wrong. The
probes were never implicated: liveness and readiness both hit `/api/v1/healthz`, which is
shallow and has no DB dependency, so a DB blip cannot evict the pod.

The pod **died**: `exitCode=1`, `reason=Error`, and in the previous container's log

```
TypeError: Cannot read properties of undefined (reading 'Symbol(pino.msgPrefix)')
```

`safeTick` — the helper whose entire job is to stop a failing scheduler tick from killing
the process — extracted its logger as `log?.warn`, which **detaches the method from its
object**. Every caller passes a real pino logger, whose `warn` needs its receiver. So the
moment a tick failed, the error handler itself threw, inside an async timer callback, which
is an unhandled rejection, which is fatal on Node 15+. The DB errors were all caught and
logged correctly; the process was killed by the code that was reporting them.

Every existing `safeTick` test passed `{ warn: vi.fn() }` — a bare object literal with no
`this` to lose — which is exactly why the suite stayed green. The guard tests now use a
receiver-bound logger; reverting the fix fails those three and leaves the original five
passing.

Also hardened, so the next instance of this class degrades instead of killing:

- global `unhandledRejection` (log loudly, keep serving) and `uncaughtException` (log, exit)
  handlers in `server.ts`;
- the outage collector's **DB** reads are now guarded like its cluster reads. A node loss is
  the one moment that endpoint exists for, and it is also the moment the DB may be mid-
  failover. Node readiness comes from Kubernetes and survives that, so the banner still
  names the down node and sets `readError` — "tenant impact unknown", never a reassuring
  zero.

### 8.2 Placement changes became permanent in silence (G2)

§3 analysed failback for storage and mail. It did not cover the tenants themselves. While a
node is down the platform moves tenants off it — HA-tier automatically, local-tier by
operator through the recovery wizard — and when the node rejoined, nothing moved back and
**nothing said so**. The returned node looked healthy while sitting empty, and an operator
who had pinned a tenant deliberately had that intent erased without a word.

The fix is a *review*, not an automatic failback. Moving storage back is real data movement
with no urgency behind it, and for an HA-tier tenant the unpinned state is usually the
better one — more nodes eligible, no single host left to lose. The platform states what
changed, says which way it leans, and leaves the decision with the operator. The same stance
as mail failover, which is never auto-enabled.

It is a projection over audit rows the platform already writes (`tenant.auto_repin` records
`strandedOn`; `tenant.repin` records `from`/`to`), so there is no new table and no background
job holding state. Acknowledgement uses the same mechanism (`tenant.failback_reviewed`),
which reduces the whole rule to **latest placement event wins** — and that falls out
correctly for repeated outages: a tenant moved off A and later off B is displaced from B, and
an ack that predates a move does not silence it.

### 8.3 The one step the platform cannot take was the quietest (G3)

The platform does not own DNS and will not withdraw records for a dead node — deliberate, per
the operator decision in §6. But the only place it admitted this was a strikethrough on an
ingress pill on the Cluster Nodes page: no addresses, no instruction, on a surface nobody
opens mid-incident. The affected-tenants modal now leads with the stale A/AAAA records, states
that nothing will remove them, and offers a copy button. Nodes with `ingress-mode: none`
contribute nothing — their addresses were never published.
