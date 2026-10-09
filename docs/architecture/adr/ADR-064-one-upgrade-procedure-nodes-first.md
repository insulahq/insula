# ADR-064 — One upgrade procedure: nodes first, pushed, and "done" means done

**Status:** Accepted (2026-10-09) — operator decisions recorded below; implementation phased (R44).
**Amends:** [ADR-045](ADR-045-versioning-release-cycle-and-upgrade.md) (W10c host-migration
delivery, #16 host-migration state, #19 the daily self-upgrade timer, the unimplemented auto-update
path) · [ADR-056](ADR-056-host-migration-failure-policy.md) (adds a `phase:` header to the
host-migration contract).
**Related:** [ADR-053](ADR-053-gitops-restructure-development-upstream.md) (release channels),
R39 (k3s upgrade runbooks).

## Context

A platform upgrade is two different things that the product presents as one.

**The services half** is a single Flux re-pin. `POST /admin/platform/upgrade` patches the
platform `GitRepository` to the release tag; the containers roll within about a minute and the
database migrations run as platform-api starts. That is all the upgrade does.

**The host half** is not part of the upgrade at all. Every node carries the signed `insula` CLI,
and a release's host-migrations ship inside that binary. A node fetches the new CLI on its own
`platform-ops-update.timer` — **daily, with up to an hour of jitter** — and only then can it run
the release's host-migrations. So a release's host changes land **0–25 hours after** its
containers. Measured on the local lab staging (v2026.10.6 → v2026.10.7-rc.1, three servers):
the services were done in 60 s; every node still ran the old CLI afterwards; the 2026.10.7
host-migration ran only when the update service was started by hand.

What follows from that split:

1. **The UI says something else.** The review modal says pending host scripts "run host-side
   (platform-ops) during the upgrade"; the progress modal showed *Host migrations: Applied ·
   3 node(s) converged* thirty seconds after Approve. Docs and code comments say "hourly" or "at
   upgrade time". All of it is wrong, and it was tolerated because an honest "host changes
   outstanding" line reads like a fault.
2. **Nothing can see a lagging node.** Nodes do not report their CLI version. A node on the old
   CLI does not know the new migrations exist, reports nothing pending, and the
   `host-migrations-converged` gate passes. A node that never reported is omitted, and the progress
   modal treats a missing gate as a pass.
3. **Order cannot be expressed.** Some host changes are needed *before* the new containers start:
   `2026.9.9/0003` creates a Secret the new CrowdSec DaemonSet mounts, which sat at FailedMount
   until each node's timer ran. Others depend on what Flux delivers (`2026.9.9/0005`). The
   authoring contract says nothing about either.
4. **Rollback is silent about hosts.** It re-pins the services; node CLIs stay newer (self-upgrade
   refuses to downgrade) and host-migrations are forward-only. The UI says neither.
5. **Adjacent defects in the same procedure:** the *Automatic updates* toggle is stored but nothing
   acts on it; re-pinning a `--env staging` cluster (Flux `ref.semver`) cannot work;
   `insula upgrade --apply` skips the pre-flight; a node that cannot read the cluster's version
   falls back to the **latest GitHub release**, which can be newer than the cluster and cannot be
   undone; Kubernetes (k3s) upgrades exist only as a CLI.

## Decision

### 1. One run, three steps, one definition of done

```
Review ─▶ 1 Prepare nodes ─▶ 2 Update services ─▶ 3 Finish ─▶ Done
          every node: fetch +   Flux re-pin (as today),   after-services host changes,
          verify the CLI, run   DB migrations             health gates, every node
          before-services host                            reports the target version
          changes
```

An upgrade is a recorded **run** (new table `platform_upgrade_runs`: from/to version, mode
manual|auto, initiator, step timestamps, per-node state, nodes excluded by the operator, outcome
succeeded|failed|aborted|rolled-back). The Task Center task, the progress view and the history all
read the run. **Done** means every service *and* every included node runs the target release and
every gate passes. In the normal case nothing is left outstanding after Done.

### 2. Nodes are pushed, not waited for — through the upgrade controller

Step 1 creates (or patches) a system-upgrade-controller Plan, `insula-node-update`, targeting the
release. Its per-node Job runs on the host:

```
insula self-upgrade --version <X> && systemctl start platform-ops-host-config.service
```

(The converge runs as the node's own unit, under its own sandbox; while the services still run
the previous release it defers every `after-services` script. Step 3's `insula-node-finish` Plan
runs only the converge.)

- **The push carries only a version.** The node downloads the release CLI and verifies it against
  its own pinned `/etc/platform/cosign.pub`, failing closed, exactly as today. A downgrade is still
  refused. The controller decides *when*, never *what runs*.
- **Why the upgrade controller:** it is already deployed (`k8s/base/system-upgrade-controller/`) and
  already the k3s upgrade path. It brings per-node status, concurrency control, and catch-up for a
  node that returns later. Servers update one at a time; workers in small batches.
- **The jobs are privileged**, as the k3s upgrade jobs are today. platform-api gains RBAC to create
  and patch Plans in `system-upgrade` (a namespaced Role); `ci-system-upgrade-check.sh` learns the
  new Plan. **Implemented:** the ValidatingAdmissionPolicy `platform-api-plan-scope` limits
  platform-api to the two Plan names, the node-terminal image with a tag or digest, the one fixed
  command each, a run-shaped `spec.version`, and no other field that could change what runs, where,
  or with which credentials.
- **The timer stays as a safety net**, but becomes an hourly *check*: it compares the node's CLI with
  the `platform-version` ConfigMap and downloads only on a change. The fallback to the latest GitHub
  release is removed: a node that cannot read the cluster's version does nothing and reports why.

### 3. Hosts first: the `phase:` header

Every host-migration declares its phase, and a CI guard enforces it:

- `# phase: before-services` (the default for new scripts) runs in step 1, **before** the services
  roll. It must work with the release that is still running.
- `# phase: after-services` runs in step 3. It may rely on what the new release deploys, and must not
  break the previous release.

The CLI selects by phase. A timer-driven converge runs an after-services script only once the
`platform-version` ConfigMap — which Flux updates with the services — has reached that script's
release. That keeps a pushed-but-not-yet-rolled node from running it early.

Both rules together are what make **rollback safe**. Everything a release did to the hosts is, by
contract, compatible with the previous release's containers. The rollback UI says so plainly: host
changes and node CLIs stay, by design.

Scripts already shipped are applied (or baselined) on every existing node and keep their behaviour.
The header is required from the next release's scripts onward.

### 4. Nodes report their truth

`status.json` gains the node's CLI version and the phase it last completed. The host-config relay
publishes both. The gates compare them with the run's target:

- A node behind the target is **pending**, never "converged".
- A node that has not reported is **unknown**, never a pass.
- The Nodes page shows each node's CLI version.

### 5. Offline nodes block — with an explicit override

A new pre-flight gate, `nodes-ready`, fails while any node is NotReady or unreachable. The operator
can choose **"upgrade without these nodes"**, which is recorded in the run. Those nodes are shown
neutrally — *will update when it is back online* — and the upgrade controller updates them when
they return. Red is reserved for real failures: a failed signature check, a failed host-migration,
a crash-looping service.

### 6. The review and progress views say what happens

- **Review:**
  - *What changes:* services vY → vX, N database migrations, and the host changes listed per node,
    using each script's description, which becomes a header.
  - *What will be interrupted:* computed from each Deployment's replica count, not the node count.
  - *Pre-flight:* today's gates plus `nodes-ready`, a node CLI that can verify, and no failed
    host-migration on any node.
  - The changelog.
- **Progress:** a resumable page (the modal becomes a view of it). It has a three-step tracker, one
  row per node (downloading → verified → host changes 3/5 → ready) and one row per service.
- **After:** run history on the Updates page, and the CLI version on the Nodes page.

### 7. Automatic updates become real

The toggle drives a scheduler that applies the newest *verified stable* release through the same
run and gates. It never applies release candidates or BREAKING releases, and it only acts inside a
maintenance window (an operator setting). A failing gate skips the run and notifies; nothing is
forced.

### 8. Kubernetes upgrades join the same flow (phase P4)

The release manifest carries the k3s version the release's bootstrap pins. When it is newer than
the nodes' kubelets, the review offers a fourth, opt-in step, *Kubernetes x → y*. It runs through
the existing k3s Plans (servers one at a time, agents drained), with the same per-node rows. That
retires the CLI-only path as the operator's tool (R39).

### 9. Same procedure everywhere

- **`insula upgrade --apply`** runs the same run, including the pre-flight.
- **`--env staging` clusters** (Flux `ref.semver`) roll services on tag publication, before any run
  exists. For them the run is created when the reconciler sees the version change, and the node
  steps follow promptly ("services first" — the one exception, documented as such).
- **Recommended staging setup:** production mode with release candidates opted in, as the local lab
  does (ADR-053 amendment). That keeps the hosts-first order.

## Consequences

- **The upgrade waits for nodes.** It takes minutes rather than one, but nothing is left outstanding
  afterwards, and the operator sees why each minute is spent.
- **A new contract obligation:** every host-migration declares its phase. Getting it wrong is caught
  in review, not in CI — the guard can only check that the header is present. The README gains
  worked examples (the CrowdSec Secret is before-services; the oauth2-proxy flag change is
  after-services).
- **More privileged surface:** platform-api can now create upgrade Plans that run privileged jobs on
  every node. The route stays super_admin-only, and the jobs can only make a node fetch a release
  its own key verifies.
- **The daily timer's role changes** from delivery mechanism to safety net. Docs that describe it as
  delivery are corrected.

## Phases (R44)

| Phase | Content |
|---|---|
| **P0 Truthful status** (ships in v2026.10.7-rc.2) | Nodes report their CLI version; the gate compares it with the target; the gate-detail bugs are fixed (missing gate ≠ pass, never-reported ≠ converged); review, remediation and interruption-preview texts are corrected; stale docs fixed. No behaviour change beyond reporting. |
| **P1 Nodes as a step** | `insula-node-update` Plan push; `phase:` header + CI guard + phase selection in the CLI; hourly check timer and no GitHub fallback (host-migration); `platform_upgrade_runs`; progress API with per-node rows; `nodes-ready` gate + override. |
| **P2 UX** | Review and progress redesign, resumable progress page, run history, CLI version on the Nodes page, first tests for the progress view. |
| **P3 Automatic updates and parity** | Auto-update scheduler with a maintenance window; CLI parity; staging-channel handling; ADR-045/056 text aligned. |
| **P4 Kubernetes** | k3s version step in the same run (R39). |

Every phase is proven the way v2026.10.7-rc.1 was: an in-place upgrade on the local lab staging
from production's release, driven in a browser, with a worker joined.

## Alternatives considered

- **A privileged pod per node, created by platform-api.** Full control and live logs, but it means
  writing our own retry, concurrency and catch-up, which the upgrade controller already does.
- **A trigger file and a systemd `.path` unit.** No privileged pod at all. But every existing node
  first needs the new unit (one daily cycle), and per-node progress is coarser.
- **Faster timers only.** The smallest change, but still asynchronous: no ordering, and progress can
  only be observed, never driven.
- **Services first, then hosts promptly.** It keeps today's script contract, but also keeps the
  FailedMount class of problems and an outstanding-host-changes window after every upgrade.
- **Never block on offline nodes.** It turns a known-partial upgrade into a silent one.
