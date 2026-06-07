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
- **Available** — the newest release the cluster has seen.

You can read the running version in the admin sidebar (under the title) and the
full spine on **Platform Settings → Upgrades**.

## How an update reaches a cluster (the pull model)

Insula uses a **pull model** — the cluster fetches and verifies releases itself;
nothing is pushed at it.

1. A **version poller** notices a newer release is available.
2. You open **Platform Settings → Upgrades** and review the version spine
   (installed → available) and the pre-flight checks.
3. You **Preview**, then **Apply** the upgrade. Apply re-pins the cluster's
   GitOps source to the verified release tag; the platform rolls every
   workload to the new version.
4. **Post-flight** checks watch the cluster converge on the new version.

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
   stays disabled until you resolve it.
3. **Host migrations** — shows whether the release carries host-level migration
   scripts and whether they will run on each node.
4. **Run upgrade** — leave the version box blank to take the latest, or type a
   specific version (e.g. `2026.7.0`). Click **Preview** to see the decision
   and target, then **Apply upgrade →**. Apply is a deliberate two-click
   confirmation: *"Re-pin the cluster to … ? This rolls every workload."*

While the upgrade rolls, a **Post-flight** panel appears and tracks convergence
to the pending version. If the cluster is not converging after several
consecutive checks, the verdict turns to **abort-recommended** and you are
prompted to roll back.

!!! warning "Apply rolls every workload"
    An upgrade restarts platform services as it re-pins. Tenant sites see brief,
    rolling restarts. Pick a low-traffic window for production and watch
    post-flight to completion.

## Rolling back

The Upgrades page also has **Roll back the last upgrade**. It re-pins the GitOps
source to the reference recorded *before* the last upgrade. A rescue snapshot is
taken before every upgrade, so the code re-pin is safe on its own.

- **Preview rollback** shows the target and how many rescue snapshots exist.
- Leave **also restore data** unchecked for a code-only rollback (the common,
  safe case).
- Tick **also restore data (revert volumes — destructive)** only when you must
  revert data to the pre-upgrade state — this reverts volumes and is
  destructive. Confirm explicitly.

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
