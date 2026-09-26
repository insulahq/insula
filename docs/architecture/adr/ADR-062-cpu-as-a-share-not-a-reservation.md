# ADR-062 — CPU is a share, not a reservation: tier requests, a burst ceiling, and panels that say which is which

**Status:** Proposed (2026-09-26)
**Related:** ADR-037 (per-component resource allocation — the allocator's floors change here),
ADR-045 (host migrations — the LimitRange rollout needs one), ADR-036 (custom containers —
they inherit the tier through the LimitRange rather than declaring it).

## Context

A production tenant's Moodle pod was killed and recreated every ten minutes for over half an
hour. Each cycle cost ~90 seconds of downtime, produced a burst of up to 38 quota-rejection
events, and surfaced to the operator as:

> This app asks for 512Mi of memory, but only 112Mi of your 1Gi plan is free — 912Mi is
> already in use.

The tenant was using **257Mi**. Nothing was short of memory. Nothing was OOM-killed. No
alert fired.

### What was actually happening

The node was at **98% of allocatable CPU requests while running at 20% actual CPU**. Every
tenant workload sits at `tenant-default` (priority 0). Platform CronJobs — including
`traefik-plugin-guard`, which fires every two minutes and asks for **10m** — sit at
`platform-critical` (10000). When a 10m job could not fit in the remaining headroom, the
scheduler **preempted** a tenant's 250m/512Mi Moodle pod to place it. Seven times in
thirty-five minutes, on a machine that was 80% idle.

The quota error was downstream: the preempted pod holds its full 512Mi against the namespace
quota for its whole 30-second termination grace period, so the ReplicaSet's replacement
attempts are refused until it finishes exiting.

### Measured on production, 2026-09-26

Node `sv1`:

| | |
|---|---|
| capacity | 8 cores |
| `systemReserved` (OS, kubelet, containerd) | 500m |
| allocatable | **7500m** |
| CPU **requests** held by pods | **7422m (98%)** |
| CPU **actually used** | **1538m (20%)** |
| CPU *limits* on tenant containers | **none — `cpu.max = max` on every one** |

What was sold against it:

| plan | per tenant | tenants | total |
|---|---|---|---|
| ultimate | 2.00 | 2 | 4.00 |
| premium | 1.00 | 4 | 4.00 |
| starter | 0.10 | 24 | 2.40 |
| | | | **8.90 cores** |

Against 7.50 allocatable, of which platform pods already hold 2.60 — leaving **4.90 for
tenants**. Sold at **1.8×** available, and above the physical core count. Nothing checks
this: `resource-quotas/headroom-gate.ts` would, but it sums the `resource_quotas` table,
which has **0 rows**, and it is wired only to `PATCH /resource-quotas` — not to
tenant creation or plan assignment, the two paths that actually sell capacity.

The reservations bear no relation to use. Across 45 pods, **5765m is reserved and unused**;
sixteen idle static sites reserve 100m each and use 0m; the Moodle pod that kept being
evicted reserves 250m and uses 1m.

### The measurement that shapes the decision

cgroup v2, read off the live node — request → `cpu.weight`, the kernel's proportional share:

| request | `cpu.weight` |
|---|---|
| 1m, 5m, 10m, 20m, **25m** | **1** — indistinguishable |
| 30m, 50m | 2 |
| 55m, 60m | 3 |
| 100m | 4 |
| 200m | 8 |
| 250m | 10 |
| 500m | 20 |
| 600m | 24 |

Two consequences. Everything at or below ~25m collapses to weight 1, so a tier ladder built
from "very small numbers" (10m / 20m / 20m) would be **theatre** — the kernel could not tell
the tiers apart. And weight 1 spans 1m–25m, so the *bottom* tier is free: only the upper
tiers need to buy separation.

### The precedent already in the repo

Every platform container that carries a CPU limit already uses low-request + generous-ceiling:

| container | request | limit | ratio |
|---|---|---|---|
| `traefik/stub` | 1m | 50m | 50× |
| `mail/rsyncd` | 10m | 500m | 50× |
| `flux-system/manager` | 50m | 1000m | 20× |
| `mail/bulwark` | 50m | 1000m | 20× |
| `platform-system/reconciler` | 5m | 100m | 20× |
| `mail/stalwart` | 100m | 1000m | 10× |

This is not the CFS-throttling anti-pattern; it is a circuit breaker. All twelve platform
namespaces also carry a `LimitRange`. **No tenant namespace has one**, and no tenant
container has a CPU limit. The platform already applies this model to itself and applies the
exact inverse — inflated requests, no ceiling — to tenants.

## Decision

### 1. A tenant CPU request is a tier, not a core count

```
Normal      5m  → cpu.weight 1     (1×)
High       30m  → cpu.weight 2     (2×)
Highest   100m  → cpu.weight 4     (4×)
```

The tier *is* the kernel's share weight. Under contention a `High` workload gets twice the
CPU of a `Normal` one; on an idle node both burst freely, because no limit binds at these
values. This replaces a number that was false in both directions — today's "1 CPU" neither
caps (no limits) nor guarantees (1.8× oversold).

Effect on the ledger: 24 starter tenants × ~2 pods × 5m is **240m**, against ~2400m today.

`DEFAULT_MIN_CPU` in `resource-allocator.ts` drops 50m → 10m, and catalog
`resources.minimum.cpu` floors drop to ~10% of `recommended` (see the companion catalog
change). `recommended.cpu` is unchanged: it stops being what a pod reserves and becomes
input to the tier mapping.

**Memory does not change.** Tenant pods run `request == limit` (Guaranteed), so a memory
request *is* the ceiling; lowering it buys an OOM kill. CPU is compressible and memory is
not, and the two get different rules on purpose. Do not align them for symmetry.

### 2. Noisy neighbours are bounded by a ceiling, not by the request

Two objects per tenant namespace, interlocking:

```
ResourceQuota
  requests.cpu = sum of tier values      ← scheduling budget (small)
  limits.cpu   = tenant-wide burst cap   ← NEW: the actual-use bound

LimitRange                               ← NEW for tenant namespaces
  defaultRequest.cpu = the tier value    ← applies the tier automatically
  default.cpu        = per-container ceiling
  max.cpu            = most a tenant may declare for itself
```

The LimitRange guarantees every container has a ceiling — including custom containers
(ADR-036) and bring-your-own images — without touching a tenant's manifests.

**The two knobs fight, and the resolution is deliberate.** `ResourceQuota.limits.cpu` caps
the *sum* of declared container limits. If the per-container `default.cpu` equalled the
tenant's whole allowance — so any single app could use it — the first container would
consume the entire quota and **the second pod would fail admission**. A tenant with three
apps could not deploy the third.

Decision: **the per-container ceiling is the tenant's full burst allowance, and the quota is
a loose backstop set well above it** (≈4×). Consequences, stated plainly rather than
implied:

- Any single app can burst to the full allowance — the common case stays useful.
- The realistic threat, one runaway process, is caught exactly by the per-container ceiling.
- The quota no longer bounds tenant-wide use at the allowance; it bounds the pathological
  many-pods-pegged-at-once case. That is a weaker guarantee than "tenant-wide use ≤ burst
  allowance", and this ADR does not claim the stronger one.

The rejected alternative was dividing the allowance by an expected pod count: it buys a
tighter theoretical bound by guessing a divisor and making the common case worse.

### Hitting the ceiling throttles; it never kills

CPU is compressible. Exceeding `cpu.max` deschedules the cgroup until the next 100ms period
— the process is slowed, never killed, never evicted. **There is no CPU eviction signal in
the kubelet** and none can be configured; the node's `evictionHard` is `memory.available`,
`nodefs.available`, `nodefs.inodesFree`, `imagefs.available`. Nothing there is CPU.

The one second-order path from throttling to a restart is a **liveness probe** timing out
while the container is starved, which the kubelet answers by restarting it. Verified on
production: **0 of 37 tenant containers declare a `livenessProbe`**, so that path does not
exist here today. If tenant liveness probes are ever introduced, the ceiling must clear
their `timeoutSeconds × failureThreshold` budget with room to spare, or a throttled pod
becomes a restarting pod. Note it on that change, not on this one.

(Memory is the opposite and is unchanged: exceeding a memory limit is an OOM kill, because
memory is incompressible.)

This does not reintroduce throttling. The objection to CPU limits is specific: a limit set
*near the request* throttles normal bursts in 100ms windows even on an idle node. A ceiling
**20–40× above the working set** engages only on a runaway — a Moodle page render spiking to
1.5 cores for 300ms never touches a 2-core ceiling. That is the ratio the platform's own
components already use.

*(This kernel supports `cpu.max.burst`, which lets a cgroup bank unused quota and briefly
exceed its limit. Kubernetes does not expose it and the kubelet rewrites cgroups, so it is
noted as a future refinement, not a lever to hand-roll.)*

### 2b. Where the tier and the ceiling live

Both are plan properties with a per-tenant override — the same shape as memory, storage,
bandwidth and mailboxes.

```
hosting_plans                          tenants
  cpu_limit        ← legacy only         cpu_limit_override        ← legacy only
  cpu_tier         ← NEW                 cpu_tier_override         ← NEW
  cpu_burst_cores  ← NEW                 cpu_burst_cores_override  ← NEW
```

`cpu_limit` is **not** reinterpreted. Despite its name it feeds `requests.cpu` today
(`k8s-provisioner/service.ts:414` — `'requests.cpu': limits.cpu`), i.e. a reservation.
Repointing the same number at `limits.cpu` would silently convert "reserve 1 core, burst
without limit" into "burst to 1 core" on clusters nobody on this side can inspect. It stays,
unused by tiered mode, read only by legacy mode, and is dropped when the migration flag is.

Migration defaults are deliberately generous so no tenant's usable burst visibly shrinks:
`cpu_burst_cores = max(1, cpu_limit × 2)` — starter 0.10 → **1.0**, premium 1.00 → **2.0**,
ultimate 2.00 → **4.0**. Starter's number rises tenfold while its freedom falls; both are
true, because the old number was never a limit.

### 3. Reserved and consumed are different numbers and must be labelled apart

Conflating them is why "0.13 cores free" read as an emergency on a machine at 20%.

- **Tenant panel** shows *actual usage* against the *burst ceiling* — two real, enforced
  numbers — plus the tier as a label. Reservations disappear from the tenant view entirely;
  under this model they are an implementation detail and were never actionable.
- **Admin panel** shows both, separately: *reserved vs allocatable* (the scheduling ledger,
  the number that causes preemption) and *actual vs capacity* (utilisation).

`packages/api-contracts/src/dashboard.ts:124` already declares
`kind: z.enum(['reserve','consume'])` and **nothing branches on it**. The distinction was
modelled and never rendered; this wires it.

Windowed peak, not instantaneous, is the tenant-facing number — instantaneous CPU on a
bursty PHP workload is noise. VictoriaMetrics (`monitoring/vmsingle`) holds the history;
metrics-server serves the live value.

### 4. Priority classes express the hierarchy; they do not compensate for the ledger

`platform-maintenance` (9000, `PreemptLowerPriority`) sits between `platform-critical`
(10000) and `tenant-default` (0), so the kubelet sheds a backup Job before the API under
memory pressure, while both still outrank tenant work.

`preemptionPolicy: Never` was considered and **rejected**: it would let a running tenant pod
indefinitely block platform maintenance on a reservation-full node, inverting the hierarchy
these classes exist to express. Routine preemption is a symptom of an impossible ledger, not
of the policy. Fix the ledger; keep the safety valve.

## Catalog schema

`resources.minimum.cpu` and `resources.recommended.cpu` are declared **required** today
(`packages/api-contracts/src/catalog.ts:131-132`). Under this ADR they stop describing what
a pod reserves, so the manifest needs to express a tier instead:

```jsonc
"resources": {
  "minimum":     { "memory": "128Mi" },        // cpu now optional (legacy)
  "recommended": { "memory": "256Mi" },
  "cpu": {
    "tier": "normal" | "high" | "highest",     // NEW, optional
    "burstHint": "2"                           // NEW, optional; capped by the plan
  }
}
```

### It must not be a flag day

The catalog is a **separate public repo**, plus an opt-in community repo
(`application-catalog-community`), consumed by any platform version an operator happens to
be running. A required schema change would mean coordinating a release across three repos
and breaking every third-party catalog in existence.

So the migration is derivation, not translation. When `resources.cpu.tier` is absent, the
platform derives it from the legacy `recommended.cpu`:

| legacy `recommended.cpu` | derived tier |
|---|---|
| ≤ 0.10 | Normal |
| > 0.10 and ≤ 0.50 | High |
| > 0.50 | Highest |

Applied to today's Official catalog that lands `static-nginx`, `static-apache`, `redis-7`
and `memcached-alpine` on Normal; the runtimes and single-service apps (`apache-php`,
`nodejs`, `mariadb`, `postgresql`, `apache-php-office`, `wordpress`, `gitea`, …) on High;
and `nextcloud`, `jitsi`, `immich`, `rocketchat`, `plausible`, `moodle-bitnami`,
`discourse` on Highest. **Every existing entry gets a sensible tier with zero catalog
edits**, and an author who disagrees declares `cpu.tier` explicitly.

`cpu` becomes optional in `minimum`/`recommended` rather than being removed — an old
manifest stays valid, a new one may omit it, and the platform prefers `cpu.tier` when both
are present. `resourceShare.minCpu` (ADR-037 per-component floors) becomes a fraction of
the deployment's tier value rather than an absolute core count; the catalog sync validator's
all-or-nothing rule is unchanged.

> The companion change lowering `minimum.cpu` across 20 manifests is the **tactical
> unblock** for operators hitting the 0.25 floor today. It is superseded by this section
> once tiers land, and is deliberately shaped so that it does not conflict: it only moves
> numbers that this ADR later makes optional.

## UI surfaces

Every surface that reads or writes a CPU number, and what changes.

### Edit surfaces

| file | today | after |
|---|---|---|
| `tenant-panel/components/DeployWorkloadModal.tsx` | free-text millicores; client floor `catalog minimum.cpu ?? 0.05` — **this is what refused 0.25 on `apache-php-office`** | tier selector (Normal/High/Highest); no numeric CPU entry; ceiling shown read-only |
| `tenant-panel/components/InstalledAppDetailModal.tsx` | free-text CPU, advisory `Min:` from the API | tier selector; "burst up to N cores" shown beside it |
| `tenant-panel/components/custom-deployments/SimpleContainerWizard.tsx` | free text, validates `> 0`; tooltip explains millicores as a guaranteed floor | tier selector; tooltip rewritten — the tier is a *share under contention*, not a floor |
| `tenant-panel/pages/DatabaseManager.tsx` | CPU entry for add-on DBs | tier selector |
| `admin-panel/pages/platform/PlansPage.tsx` | `cpu_limit` in cores per plan | plan sells a **default tier + burst ceiling**; `min=0`/`required` already fixed in the companion patch |
| `admin-panel/pages/TenantDetail.tsx` | `cpu_limit_override` in cores, `min(0.1)` in the contract | per-tenant **ceiling** override + default tier; the `min(0.1)` floor goes |
| `admin-panel/pages/Applications.tsx` | renders `d.cpuRequest` as a raw millicore column | tier label + ceiling |

### Display surfaces

| file | change |
|---|---|
| `tenant-panel/pages/ResourceUsage.tsx` | drop `reserved`; show windowed peak vs ceiling |
| `tenant-panel/pages/Dashboard.tsx` | CPU tile becomes used-vs-ceiling |
| `tenant-panel/components/layout/Header.tsx` | the `0.00/2.0` chip currently reads reserved — becomes used-vs-ceiling |
| `tenant-panel/components/ResourceMetricsModal.tsx` | same split |
| `tenant-panel/components/ResourceBreakdown.tsx` | per-component *allocation* is a share split, not cores — relabel |
| `tenant-panel/components/ResourceRequirementCheck.tsx` | "0.10 cores available (0.10 required)" is a reservation check; under tiers it gates on **memory** and pod count, not CPU |
| `tenant-panel/pages/Settings.tsx` | plan summary: tier + ceiling, not cores |
| `admin-panel/pages/Dashboard.tsx` | split `committed` (reserve) from `inUse` (consume); label both |
| `admin-panel/pages/ClusterNodes.tsx` | show allocatable, reserved and actual as three distinct figures |
| `admin-panel/components/system-backup/MigrationTab.tsx` | carries plan CPU through a migration — must carry tier + ceiling |

Contract changes in `@insula/api-contracts`: a `cpuTier` enum, `burstCeiling`, and the
`kind: 'reserve' | 'consume'` discriminator actually consumed by both panels.

## Rollout

Two failure modes to avoid, not one. Breaking an unknown cluster is the obvious one. The
other is shipping a migration that defaults to off and is therefore never applied — the
operator who most needs this is, by construction, the one who does not know they have the
problem, because the panel currently hides it by conflating reserved with consumed.

So the sequencing is driven by *adoption*, not only by safety.

### R1 — diagnosis only, no behaviour change

Ships to everyone, changes nothing, safe on any cluster:

- The panels stop conflating reserved with consumed (Decision 3, `kind` finally rendered).
- A health finding that states the operator's own numbers: *"this node reserves 98% of
  allocatable CPU while using 20%; 45 pods hold 5765m they never use."*
- The **dry-run report**: per tenant, current request → proposed tier, proposed ceiling, and
  a classification — *migrates cleanly* or *needs review, because…*

This is the release that creates the demand. Nobody opts into a scheduling-model change
described in an ADR; an operator who is shown six reserved-and-unused cores on their own
cluster will act. Shipping the measurement before the mechanism is the whole strategy.

### R2 — mechanism, opt-in, per tenant

`cpu_tier` / `cpu_burst_cores`, the LimitRange, the guard that refuses to add `limits.cpu`
to a quota until it has verified the LimitRange exists and every running pod already carries
a limit. Default resolves to `legacy` on any install that already has tenants.

Migration is a panel action with the dry run in front of it, **per tenant**, not a config
key in a file. Ordered by benefit, because the order matters:

> **Migration is self-easing.** Every migrated tenant *reduces* its reservation, so each one
> makes the next safer. On the cluster measured here, re-tiering the sixteen idle static
> sites alone (100m → 5m) frees **~1.5 cores** and takes the node from 78m of headroom to
> over 1.6 — after which nothing preempts anything. Migrate the biggest over-reserver first;
> do not save it for last.

This inverts the usual instinct to leave a tight cluster alone. Recreating a pod under the
new model is *easier* to schedule than the pod it replaces, because the new request is
strictly smaller. The only risk window is the ~30 s where the terminating and the new pod
both count — the failure this ADR already characterises, and one the smaller request makes
shorter, not longer.

**Correction to an earlier draft of this section.** "Tiers apply as pods naturally cycle; a
forced rollout is not required" is right as a *default* and wrong as a *strategy*: on a
stable cluster nothing cycles for months, the ledger never drains, and the operator
concludes the migration did nothing. Replace it with a **paced, operator-initiated
recreation** — one tenant at a time, a health gate between, a stop button, and the prior
request stored so a single tenant can be reverted exactly.

Most tenants need no human decision. The dry run auto-classifies; only these need review:

- custom containers (ADR-036) that declare their own resources,
- tenants whose measured p95 already exceeds the proposed ceiling,
- entries from third-party catalog repositories we have never seen.

### R3 — tiered becomes the default for fresh installs

Existing clusters keep `legacy`, but visibly: a standing panel notice carrying their own
reserved-vs-used figures and a link to the dry run. `legacy` and `cpu_limit` are removed in
a later major, at which point the migration flag goes with them.

### Admission control, and why the grandfather question dissolves

The open question — production is 1.8× oversold, so do we grandfather or force a re-plan? —
was the wrong question, because it assumes the platform keeps selling reservations.

Under this ADR it does not. What a plan sells becomes:

- **a share** (the tier), which *cannot* be oversold — shares are relative by definition; and
- **a burst ceiling**, which is *meant* to be oversubscribed. Summing the ceilings across 30
  tenants gives ~40 cores on an 8-core node, and that is correct: it is the same shape as
  memory *limits* already sitting at 152% of allocatable. A burst product that is not
  oversubscribed is just a small dedicated server.

So admission control must gate on the two things that genuinely cannot be oversold —

```
sum(tier requests) + platform baseline  ≤  allocatable      (scheduling)
sum(memory requests)                    ≤  allocatable      (incompressible)
```

— and **not** on the sum of burst ceilings. After migration the first sum is tiny (the
measured cluster lands near 3 cores against 7.5), so the existing 1.8× overage stops being
a violation of anything: nobody is grandfathered and nobody is re-planned, because the
quantity that was oversold is no longer the quantity being sold.

The headroom gate still needs repairing to be worth anything — it sums `resource_quotas`,
which has 0 rows, and is wired only to an endpoint that is not how capacity is sold. It
should read `hosting_plans` + `tenants` overrides and be called from tenant-create and
plan-change. That repair is independent of the tier model and can ship in R1.

## Safety for clusters we cannot see

The platform ships under AGPL and production moves when an operator pulls a signed release.
There is no telemetry and no inventory: assume unknown clusters, unknown versions, unknown
tenant workloads, and no ability to inspect or roll back for them. The three parts of this
change have very different blast radii and must be treated separately.

### Safe as-is — no operator action

**PriorityClass + CronJob retarget.** Purely additive: a new cluster-scoped object and a
rank change that only affects kubelet eviction ordering. Verified in the rendered overlay
that Kustomize emits all PriorityClasses (docs #160–164) before any CronJob (#184–191), so
there is no window in which a CronJob references a class that does not yet exist.

**`DEFAULT_MIN_CPU` 50m → 10m.** Strictly permissive — budgets that used to be rejected now
allocate, and nothing recomputes an existing deployment. It cannot break a running cluster.

### The catalog is the part that reaches everyone regardless of version

One public repo, synced by every operator on whatever platform version they run. The
compatibility property that makes this survivable: `resources` is carried through sync as an
opaque `Record<string, unknown>` (`catalog/service.ts:72`), stored as JSON, and read with
ad-hoc casts — it is **not** Zod-validated at sync and the manifest schema is not `.strict()`.
So an unknown key is **stored and ignored** by an old platform rather than failing its sync.

That yields one hard rule:

> **Add, never remove.** `resources.recommended.cpu` and `resources.minimum.cpu` stay in
> manifests indefinitely. Old platforms read them, and the catalog sync validator compares
> `sum(resourceShare.minCpu) ≤ resources.recommended.cpu`. Removing them would break every
> platform version that predates the tier field, silently and remotely.

One cross-version wrinkle remains even so: an old platform syncing the lowered floors will
advertise `Min: 0.05` in its panel while its own allocator still enforces 50m, so the UI
offers a value the backend rejects. A validation error, not damage — but it argues for
shipping the catalog floor change **with** the platform change rather than ahead of it.

### The tier model is where an unknown cluster can actually be hurt

The dangerous mechanic is narrow and specific: adding `limits.cpu` to a ResourceQuota makes
a CPU limit **mandatory for every new pod in that namespace**. Applied to a cluster whose
containers do not all have one, every tenant deploy fails admission — while running pods stay
up, so it looks healthy until the operator's next deploy or the next pod recreation.

Seven requirements, all of which are about not needing to know anything about the cluster:

1. **Upgrading changes nothing.** A `cpu_scheduling_model` setting resolves to `legacy` for
   any install that already has tenants and is seeded `tiered` only on fresh install. This is
   a **migration flag with a removal date**, not the permanent product mode rejected above —
   it exists to avoid a behaviour change on upgrade, and should be deleted once the migration
   is complete. Saying so here so it does not silently become a forever-fork.
2. **The sequencing is a guard, not a runbook step.** The reconciler adds `limits.cpu` to a
   tenant quota only after verifying the namespace has a LimitRange *and* every running pod
   in it already carries a CPU limit — and removes the quota field again if that stops being
   true. An operator we cannot see does not benefit from a note in a document.
3. **Dry-run before anything changes.** A read-only per-tenant report — current request →
   proposed tier, proposed ceiling, and every deployment that would not fit — rendered in the
   panel and available from the CLI.
4. **Per-tenant, not cluster-wide.** Migrate one tenant, observe, continue. A cluster-wide
   flip is unnecessary risk on hardware nobody on this side has seen.
5. **Reversible from a stored prior value.** Switching a tenant back to `legacy` restores the
   exact previous request, read from a stored marker — not recomputed. A marker that records
   only "this was changed" forces recovery to guess.
6. **No forced pod recreation.** Tiers apply as pods naturally cycle. Rolling every tenant
   workload at once on a cluster already tight on CPU is precisely the outage this ADR exists
   to prevent.
7. **Preflight the things we cannot assume**: custom containers (ADR-036) that declare their
   own resources, third-party catalog repositories with manifests we have never seen, and
   tenants whose workloads genuinely warrant a large share.

### Release communication

With no telemetry, the release notes are the only channel. `CHANGELOG.md` already carries the
mechanism: a `### BREAKING` subsection makes auto-update refuse to apply the release until an
operator acknowledges it. Step 4 of the rollout — `limits.cpu` on tenant quotas — must ship
under that marker. Steps 1–3 must not, because they change nothing on upgrade.

## Consequences

**Accepted.** CPU stops being admission control — memory requests and the quota's `pods`
count become what prevents overpacking. That is correct (memory is the incompressible
resource) but must be sized deliberately, especially on small nodes. Weights divide scarcity
fairly; they do not create capacity: 200 `Normal` pods on a 2-core node each get 1/200 of a
core under full contention, and the burst ceiling is a cap, not a floor.

**Given up.** The ability to tell a customer "you get exactly 1 core, always" — which the
platform does not actually provide today either.

**Gained.** Plans become honest: *"High CPU priority, burst to 2 cores"* is two true,
enforced statements. Preemption returns to being exceptional. The 5765m of phantom
reservation is released.

## Alternatives rejected

- **Enforce CPU limits at the request level** (the "conventional Kubernetes" option).
  Prevailing guidance runs the other way — always set requests, avoid CPU limits — because
  CFS quota throttles in 100ms windows even on an idle node, and bursty PHP request handling
  is the worst-affected shape. It also does nothing for the problem at hand: placement is on
  requests, so this would leave preemption fully intact while adding a new failure mode.
- **`preemptionPolicy: Never` on maintenance work.** See Decision 4.
- **An operator-selectable scheduling mode, built now.** A hoster selling guaranteed vCPU is
  a legitimately different product, so the mode switch is a reasonable *future* seam — but
  two live code paths means two support matrices and two sets of failure modes, and the
  second has no user yet. Ship one default; add the mode when someone needs it.
- **Repurposing `systemReserved`'s 500m.** It belongs to the OS, kubelet and containerd, and
  is what keeps the node reachable when it saturates. Handing it to platform pods defeats its
  only purpose.
