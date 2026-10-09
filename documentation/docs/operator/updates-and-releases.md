---
verified: 2026.6.7
---

# Updates & releases

Insula ships as versioned releases. As the operator you decide *when* a cluster
takes an update, and the platform handles *how* — verifying, pre-flighting, and
rolling out without you logging into every node.

## How versions work

Releases use **CalVer**: `YEAR.MONTH.PATCH`, e.g. `2026.6.5`. There are no
leading zeros on the month. Every running cluster reports three versions:

- **Installed** — the release this cluster is pinned to.
- **Running** — the build actually serving you (installed version + a short
  commit suffix, e.g. `2026.6.5-310a877`).
- **Available** — the newest release the cluster has seen, verified against the
  platform's signing key before it is offered.

You can read the running version in the admin sidebar (under the title) and the
full spine on **Platform Settings → Upgrades**. Versions display with a leading
`v` throughout the panel, matching the git tags and release assets — `v2026.6.5`,
not `2026.6.5`.

The "platform update available" banner names the version you can move **to**,
with the one you are on beside it: *Platform update available: v2026.6.6
(current: v2026.6.5)*.

## How an update reaches a cluster (the pull model)

Insula uses a **pull model** — the cluster fetches and verifies releases itself;
nothing is pushed at it.

1. A **version poller** notices a newer release is available.
2. You open **Platform Settings → Upgrades** and review the version spine
   (installed → available) and the pre-flight checks. The *update available*
   banner's **Review & apply** takes you straight into the review dialog rather
   than dropping you on the page to find it again.
3. You **Preview**, then **Apply** the upgrade. Apply starts an **upgrade run**
   in three steps: every node first fetches and verifies the release's
   `insula` CLI, then the cluster's GitOps source is re-pinned to the verified
   release tag and the platform rolls every workload, and finally the nodes
   apply the host changes that need the new services.
4. **Post-flight** checks watch the services converge on the new version; the
   run reports done once the nodes have finished too.

!!! note "Non-production clusters auto-follow their branch"
    Production is manual and gated, as above. Non-production environments follow
    their branch automatically — the Upgrades page tells you which mode you are
    in.

## Running an upgrade

On **Platform Settings → Upgrades** (`super_admin`):

1. **Version spine** — confirms installed vs. available and flags
   *update available*.
2. **Pre-flight checks** — a live list of gates (pass / warn / fail). Click
   **refresh** to re-run them. If any **blocking** check fails, the Apply button
   stays disabled until you resolve it. Three checks are about the nodes:
   **Every node can take part** (see [Upgrading with a node down](#upgrading-with-a-node-down)),
   **No failed host change on a node** (a failed host migration blocks every later
   one on its node, so fix it or record a skip first; blocking in production), and
   **Every node can verify a release** (the node's pinned signing key
   `/etc/platform/cosign.pub` is present; without it the node refuses the
   release). **Flux reconciling the platform** fails
   when the platform Kustomization or its git source is suspended (for example
   after a manual rollback) — the upgrade only re-pins the release Flux applies,
   so it would change nothing. Resume them first:
   `flux resume source git <name>` and `flux resume kustomization platform`.
3. **What changes** — the services' version before and after, how many database
   and platform migrations the release still has to run here, and each **host
   change** by its one-line description: whether it runs *before the services*
   or *after the services*, and on which nodes (a node that already has it is
   left out). A node that has not reported its host state is named, never counted
   as done. Releases cut before 2026.10.7 do not list their changes, and the
   dialog says so. The upgrade applies the host changes on every node as part of
   the run (see [The upgrade run](#the-upgrade-run)).
   The dialog also names the services that run a **single replica**. Those see a
   short gap while they restart, even on a multi-node cluster. Services with more
   than one replica roll over without one.
4. **Run upgrade** — leave the version box blank to take the latest, or type a
   specific version (e.g. `2026.7.0`). Click **Preview** to see the decision
   and target, then **Apply upgrade →**. Apply is a deliberate two-click
   confirmation: *"Re-pin the cluster to … ? This rolls every workload."*
5. **Review changelog** — in the review dialog, next to the approve button.
   Opens the release notes for the version you are about to install, with
   **Approve & upgrade** available from there too, so reading what changed is
   not a detour. **Cancel** returns to the review with the pre-flight result
   intact.

    Notes are fetched by the platform, not by your browser, so a workstation
    with no route to GitHub still sees them. Two things it may tell you instead
    of notes, and they mean different things: *no release notes were published*
    (normal for a development build, which has no release page) versus *could
    not be fetched* (this cluster has no outbound access to GitHub — which says
    nothing about the release). Neither blocks the upgrade.

While the upgrade rolls, a **Post-flight** panel appears and tracks convergence
to the pending version. If the cluster is not converging after several
consecutive checks, the verdict turns to **abort-recommended** and you are
prompted to roll back.

Convergence is **not** just "every workload restarted". Post-flight also gates on
**Platform migrations applied**: a release whose platform migrations are stuck is
reported as an incomplete upgrade, even when every pod runs the new image.

**Host migrations** appear in post-flight too, but they never fail the services'
convergence. The run applies them on the nodes (next section). A node the run left
out, because you upgraded without it, reads **Catching up** until it has updated
on its own. That is expected, not a fault. The row reads **Needs attention** only
when a node actually reports a failed or blocked migration.

!!! note "Why migrations gate the verdict"
    One failed platform migration halts every later one indefinitely. Without
    this gate an upgrade could report success while, for example, the migration
    that installs the wildcard-certificate issuers had been refused — leaving
    certificates that never issue and no failing object to point at. A halted
    registry now also raises a critical alert naming the migration that failed.

    If the migration status cannot be read at all, that is a **failure**, never a
    silent pass.

!!! warning "Apply rolls every workload"
    An upgrade restarts platform services as it re-pins. Tenant sites see brief,
    rolling restarts. Pick a low-traffic window for production and watch
    post-flight to completion.

## The upgrade run

Apply starts one **run**, shown step by step in the progress dialog. You can
close the dialog and reopen it from the Tasks chip, or use **Open page**: every
run has its own page (*Platform Settings → Updates → Upgrade history*), which
survives a reload and stays as the record of how the run ended — each node's
outcome and the message it stopped with. Cancelled and rolled-back runs are
listed as such, apart from failures.

1. **Update the nodes.** Each node, one at a time, fetches the release's
   `insula` CLI, verifies its signature against the key the node pins, and
   applies the release's host migrations marked *before the services*. The
   services keep running the current release meanwhile.
2. **Roll the services.** Only once every node is ready does the platform take a
   rescue snapshot and re-pin the GitOps source, as described above.
3. **Finish host changes.** Each node applies the host migrations that need the
   new services, then reports the release.

Each node row says where it stands: *Queued*, *Updating*, *Ready*,
*Waiting for node*, *Upgraded without* or *Failed*, with one line on why. Once a
node runs the release's CLI, its row also counts the release's host changes
(*host changes 1/2*). The **Nodes** page shows each node's `insula` CLI version,
marked *update pending* while it is older than the release the cluster runs.

- **A failure in step 1 stops the run before the services change.** The services
  still run the previous release. The nodes that did update keep the new CLI
  and its before-services changes, which work with the previous release by design.
- **Cancel upgrade** is offered during step 1, with the same result: nothing
  changed for the services. Once the services roll, the way back is the rollback
  below.
- A node that does not get ready within 25 minutes, or one whose node update
  fails three times, stops the run the same way. The row names the host
  migration that failed. The job log is in the `system-upgrade` namespace.

### Upgrading Kubernetes in the same run

Each release pins a k3s (Kubernetes) version for fresh installs. When that version
is newer than your nodes run, the review offers **Also upgrade Kubernetes x → y**.
It is off by default. Ticked, the run gets a fourth step after the host changes:
servers one at a time, then each worker drained (its tenant sites move while it
is drained) and upgraded. Its node rows show each node's Kubernetes version. The
step is offered only for a safe hop: a newer patch, or the next minor version.
A cluster further behind is told to use `insula cluster upgrade`, which steps
one minor version at a time. If the step fails, the services and host changes
are already done; the run says on which node the Kubernetes upgrade stopped.

### Upgrading with a node down

The run updates **every** node, so a node that is not Ready blocks the upgrade:
the pre-flight check **Every node can take part** fails and names it. If the node
will not be back soon, tick **Upgrade without** next to it in the review dialog.
The run then leaves it out, and the node updates itself through its own hourly
update check once it is back. It runs no release ahead of the cluster: the check
only ever fetches the release the cluster runs. If a node goes down *during* step 1,
the run waits for it. Cancel, then start the upgrade again without it.

## Automatic updates

**Automatic updates** (Platform Settings → Updates, `super_admin`) apply a new
release for you, through the same run and the same pre-flight checks as a manual
upgrade. They act only when all of this holds:

- the release is **verified** and **stable** — never a release candidate, never a
  release whose notes carry a `BREAKING` section (those you read and apply by hand;
  you are notified);
- no upgrade is already running;
- it is inside your **maintenance window** — the weekdays and the start and end
  time you set, in the time zone you choose. A window whose end is before its
  start runs past midnight; equal start and end means the whole day. **Without a
  saved window, automatic updates do nothing**;
- the pre-flight passes. A failing check skips that window and notifies you once;
  nothing is forced.

Under the toggle the page says what automatic updates did last and why — for
example *2026.11.1 applies in the next maintenance window: Sun 02:00–05:00 (UTC)*.
A started run appears in the upgrade history like any other, marked *automatic*.

### Clusters on a release channel

A cluster whose GitOps source follows a release **channel** (a semver range, as a
staging cluster set to auto-follow does) rolls the services as soon as a release is
published, before any upgrade run exists. The platform then starts a run for that
release by itself, so the nodes follow promptly with the same per-node view. That
is the one case where the services go first. A node that is down is left out and
catches up on its own when it is back. For the hosts-first order on staging, run it
in production mode with release candidates opted in.

## Rolling back

The Upgrades page also has **Roll back the last upgrade**. It re-pins the GitOps
source to the reference recorded *before* the last upgrade, and ends a run that is
still finishing. While a run is still updating the nodes, the rollback is refused:
the services have not changed, so cancel the run instead. A rescue snapshot is
taken before every upgrade, so the code re-pin is safe on its own.

- **Preview rollback** shows the target and how many rescue snapshots exist.
- Leave **also restore data** unchecked for a code-only rollback (the common,
  safe case).
- Tick **also restore data (revert volumes — destructive)** only when you must
  revert data to the pre-upgrade state — this reverts volumes and is
  destructive. Confirm explicitly.

## Host migration state (per node)

Some releases carry **host migrations** — small scripts that change the host
itself (a version pin, a systemd unit, a firewall shape). They cannot travel
through GitOps, so each node applies them locally on its own hourly converge.

Outside an upgrade, each node also re-checks its host migrations every hour, and
its CLI checks every hour for the release the cluster runs. That is how a node the
run left out, or one that joins later, catches up.

The **Host migrations** card on the same page shows what each node has done:
applied, pending, failed, blocked, or skipped.

**A failed migration deliberately blocks every later one on that node.** A later
script may assume an earlier one applied, so the runner halts rather than
applying migrations out of order. That is why a single failure can leave a node
reading *0 applied, 11 pending* — the queue is intact, it is waiting.

When a node needs attention it expands itself and shows:

- the migration that failed and **why**,
- how many times it has been retried and **since when** — a handful of attempts
  is a transient failure clearing itself; hundreds since July is a deterministic
  one that will never clear on its own,
- anything an operator has skipped, with the reason recorded.

!!! danger "\"Never converged\" is the one to act on"
    A node marked **never converged** has run *no* host-migration at all — not a
    queue that is waiting, an empty one that nothing is processing. Its hourly
    converge timer is missing, so unlike every other state on this card it does
    **not** clear itself, and every migration ever shipped is unapplied.

    The card prints the exact commands to run from a root shell on that node.
    There is no button, because there is nothing the panel can press: the agent
    that reports this state is read-only by design and cannot install a systemd
    timer. The usual cause is a bootstrap before v2026.8.21, where the installer
    skipped the timers when the CLI binary was already at the released version.

    A newly added node stays quiet for its first couple of hours — that is a
    normal wait, not this.

Each node row also shows the node's **CLI version**. A node whose CLI is older
than the release running in the cluster reads **Catching up**. It has not received
that release's host migrations yet, so none of them count as pending or failed.

!!! note "There is no Retry button, on purpose"
    Migrations re-run **automatically every hour** on each node, and a node also
    converges immediately after it self-upgrades. A transient failure clears itself
    and a fixed cause is picked up without you doing anything; a button would only
    wait for that same converge. Fix the cause on the node, then run
    `insula host-config apply` if you don't want to wait out the hour.

If a migration can *never* apply to a host — it targets something that host
doesn't have — record a skip so the rest of the chain proceeds. Never create the
`.done` marker by hand: that reports the migration as **applied**, and the next
one will assume work that never happened. The
[host-migration troubleshooting runbook](https://github.com/insulahq/insula/blob/main/docs/operations/HOST_MIGRATION_TROUBLESHOOTING.md)
walks through both, and the card links straight to it.

A node that has never converged, or one running an older agent, reports *not
reported yet* rather than an error — that is normal on a fresh install and is
not flagged as a problem.

## Platform migration state (cluster-wide)

Host migrations run per node; **platform migrations** run once for the cluster and
change platform state rather than the host — creating a cluster resource, seeding
a setting, reconciling something the API owns.

They halt on the first failure for the same reason host migrations do: a later
migration may assume an earlier one applied. A halted registry therefore stays
halted until the cause is fixed — it does not skip ahead and it does not retry
its way out of a deterministic failure.

You can see the state three ways:

- the **Post-flight** panel during an upgrade (**Platform migrations applied**),
- a **critical alert** that names the migration that failed,
- `GET /api/v1/admin/platform/migrations`, which reports each migration, how many
  are pending, and whether the registry has converged.

!!! tip "A migration that touches a cluster resource needs the permission to do it"
    The most common cause of a halted registry is a migration that creates or
    modifies a cluster resource the platform's own role is not allowed to touch —
    it fails with a 403 and blocks everything after it. A CI guard now checks that
    pairing, so this should not reach a release.

## `platform-ops` on your hosts

Every node carries `platform-ops`, a small CLI that does the on-host half of the
pull model. You normally drive upgrades from the admin panel, but `platform-ops`
is there for diagnostics and for running an upgrade from a node when the panel is
unavailable.

Common read-only commands (run on any node):

```bash
platform-ops version              # installed / running / available
platform-ops cluster status       # node + control-plane health
platform-ops cluster diagnostics  # best-effort support bundle
platform-ops migrations list      # platform migrations + applied status
```

The privileged operations (`cluster upgrade`, `upgrade`, `rollback`,
`migrations apply`, `dr restore`) exist for break-glass use — prefer the panel.

!!! note "Releases are signed; nodes verify before installing"
    Release binaries are signed, and each node verifies the signature with
    `openssl` (already present on every node) before installing — a tampered or
    truncated download is refused. You do not run any verification step
    yourself; it is built into the upgrade path.

The runbook for the on-host side is
[Cluster Maintenance & Upgrades](https://github.com/insulahq/insula/blob/main/docs/operations/CLUSTER_MAINTENANCE_AND_UPGRADES.md);
the design rationale is
[ADR-045](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md).

??? info "Under the hood"
    Apply does not push images — it re-pins the cluster's Flux source to the
    release tag and lets Flux reconcile. The version spine is fed from
    `platform/VERSION` through CI into a ConfigMap and the DB
    `installed_platform_version`. Host-migration scripts are embedded in the
    `platform-ops` binary and run per node according to the host-migration
    policy. Pre-flight gating is enforced server-side, not just in the UI — the
    re-pin is refused if blocking gates fail. Post-flight tracks consecutive
    convergence failures against an abort threshold.
