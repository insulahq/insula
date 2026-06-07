# ADR-045: Versioning, Release Cycle, Pull-Model Upgrade, and Operator CLI

**Status:** Accepted (2026-06-01)
**Author:** Sebastian Buchweitz

**Amendments:** 2026-06-01 — Decision 6 CalVer dropped the leading-zero month
(`YYYY.0M.PATCH` → `YYYY.M.PATCH`, e.g. `2026.6.1`) so the platform version is
valid SemVer and stays in lockstep with `package.json`; version ordering must
use semver-aware comparison, never raw string sort. Operator-approved; mirrored
in the holistic plan §15 and `CONTRIBUTING.md`.

**Amends:** `docs/history/04-deployment/CLUSTER_UPGRADE_ROADMAP.md` (carries forward 17
of its 20 locked decisions; amends 3 — see §6).

**Implemented by:** `docs/history/04-deployment/HOLISTIC_RELEASE_AND_UPGRADE_PLAN.md`
(workstreams W0–W17, 20 PRs). This ADR is the decision record; that plan is the
implementation roadmap. W0 = "this ADR is merged before any implementation PR."

**Related:** ADR-022 (external DNS/IAM/mesh — the pull model never reaches into
those), ADR-029 (secrets + DR — `platform-ops dr restore` absorbs the DR path),
ADR-043 (rclone-s3-shim — backup/snapshot primitives the CLI wraps).

---

## Context

Five concerns surfaced in the 2026-05-23 planning session, all coupled around a
single artefact — "what version is this cluster?":

1. **No single source of truth for cluster version.** The admin UI, in-cluster
   Flux, the audit log, a future upgrade pre-flight, and fork operators each
   infer the running version from a different surface; none agree by
   construction.
2. **No written release cycle.** `release.yml` fires on `v*.*.*` tags, but
   nothing documents when to cut a tag, what level to bump, how notes are
   curated, or how staging soak relates to production cutover.
3. **Stale CI/CD spec.** `CICD_PIPELINE_REQUIREMENTS.md` still describes MariaDB,
   Harbor, NetBird-in-CI, and a weeks-1-12 Phase framing that no longer matches
   the as-built 3-branch GitOps flow.
4. **OSS readiness documented but not implemented.** No `LICENSE`,
   `CONTRIBUTING.md`, `SECURITY.md`, image-org preflight, or fork-safe CI guards
   exist at repo root.
5. **The cluster-upgrade roadmap depends on all four above.** Implementing the
   upgrade pipeline before these land would bake their absence into the flow.

A sixth concern emerged during planning: **OS-level work the upgrade must
perform** (sysctls, apt/dnf packages, kernel, k3s version, per-release
imperative migrations, DR script distribution) was originally scoped as an
ops-runner Job that SSHes from the cluster to each node. The operator has
**rejected the push-to-cluster model**: a cluster must *pull* what it needs, and
an operator CLI must work even when k8s is partly or fully down.

This ADR locks the decisions that resolve all six together. They are coupled
because they share one artefact — `platform/VERSION` — and one principle: the
cluster converges itself; nothing pushes into it.

---

## Decision

### Architecture in one paragraph

`platform/VERSION` (CalVer, one line) is canonical. Everything else is a
transformation of, or a check against, that value: a git tag, an image
label/env, an in-cluster `platform-version` ConfigMap, a DB row, and an API
surface that drives the admin UI. Each cluster **polls** the GitHub Releases
feed hourly, cosign-verifies, and applies new versions **itself** by PATCHing
its own Flux `Kustomization.spec.ref.tag` — then platform-migrations,
host-config convergence, and system-upgrade-controller Plans roll the rest. For
failure modes (cluster down) and per-node work, a self-contained **TypeScript**
binary `platform-ops` runs on demand on each node, importing the same backend
modules the in-cluster controllers use. The whole thing is fork-safe: AGPL-3.0,
image-org preflight, cosign keys a fork replaces with its own.

### The 21 locked decisions

These are settled. Implementation MUST honour them. A change requires an
amendment to this ADR (and a mirrored note in the holistic plan §15 change log).

| # | Topic | Decision |
|---|---|---|
| 1 | LICENSE | **AGPL-3.0.** Strongest copyleft; mirrors Plausible/Mastodon/Nextcloud; prevents closed-source SaaS forks of a hosting platform. |
| 2 | Release cadence | **Ad-hoc.** No time-boxed schedule. Operator cuts a tag when accumulated changes warrant a release. Drift-tracker workflow explicitly skipped. |
| 3 | Pre-release identifier | **`-rc.N`** only. No `-beta.N` distinction. |
| 4 | `CICD_PIPELINE_REQUIREMENTS.md` disposition | **Rewrite in place.** Historical phase framing is not load-bearing; replace with as-built spec. |
| 5 | `platform/VERSION` between tags | **Pinned to last released tag.** Between tags the file says e.g. `2026.5.1` while CI computes `2026.5.1-<sha>` for the development cluster. `cut-release.sh` is the only thing that edits the file. |
| 6 | Versioning scheme | **CalVer `YYYY.M.PATCH`** (e.g. `2026.6.1`). **No** leading-zero month, so the version is valid SemVer (npm / `semver` / `sort -V` compatible) and platform/VERSION stays in lockstep with `package.json`; version ordering MUST use semver-aware comparison, never a raw string sort. PATCH starts at `.1`. Breaking-change signal carried by a `### BREAKING` heading in CHANGELOG; auto-update refuses to auto-apply any release whose CHANGELOG section contains `BREAKING`. |
| 7 | Auto-update defaults | **Staging ON, production OFF, local clusters N/A** (button hidden). Stored in `platform_settings.upgrade.auto_update_enabled`. |
| 8 | Release feed source | **GitHub Releases API** of `PLATFORM_RELEASES_REPO` env (default `insulahq/insula`, fork-overridable). **Cosign signature** on release artifacts verified before any apply. Public key pinned in `platform/cosign.pub`. Fork operators MUST replace this key with their own. |
| 9 | Release tagging | **Manual only** via `scripts/cut-release.sh`. No auto-promote from development/main. |
| 10 | `stable` branch | **DROP.** `release.yml` stops opening PRs to stable. Production Flux pins `spec.ref.tag` directly; version-poller re-pins on operator click. |
| 11 | Pre-releases | `cut-release.sh --prerelease` produces `YYYY.M.PATCH-rc.N`. GitHub Release `prerelease=true`. Separate flag `auto_update_include_prereleases` (default ON staging / OFF prod). |
| 12 | Staging cluster mode | **Mode A only, Phase 1.** Mode A = Flux watches `development` branch tip (every-commit bleeding-edge smoke). Mode B (Flux pins latest `-rc.N` tag) deferred. |
| 13 | Branch naming | Rename `staging` → `development`. **No new `staging` branch.** "Staging cluster" survives as a cluster-role name only. Tags carry all release semantics. |
| 14 | OS-level changes strategy | Three complementary mechanisms: (a) **continuous reconciler** for declarative drift (sysctls, modules, ulimits, declared apt/dnf packages); (b) **per-release host-migration runner** for one-shot imperative scripts; (c) **operator CLI** for failure-mode and ad-hoc work. Operator NEVER manually re-bootstraps for a non-BREAKING release. |
| 15 | DR ownership | **No standalone DR script.** DR is absorbed into `platform-ops` as `platform-ops dr restore`. `dr-drill.yml` extended to exercise this path. |
| 16 | Host-migration safety | Each migration recorded per-node in a ConfigMap. Halts on first failure. Operator-resumable via UI. Surfaces in pre-flight before any Apply. Shell migrations shellcheck-linted in CI. |
| 17 | Operator CLI surface | **TypeScript binary** packaged via `pkg` (or `bun build --compile`), ~50–80 MB self-contained, at `/usr/local/bin/platform-ops`. **No container, no daemon.** Installed and cosign-verified by bootstrap.sh on first run. Optional ~500-LOC Go wrapper handles ONLY the self-upgrade + cosign-verify loop for static-binary purity; deferred unless needed. (Revised 2026-05-23 from "pure Go binary" — orchestration logic lives canonically in TS modules; Go would re-implement 4,000–8,000 LOC and maintain two copies forever.) |
| 18 | Code-sharing | CLI entrypoint `backend/src/cli/platform-ops.ts` **directly imports** the backend TS modules under `backend/src/modules/`. No shared-library indirection; the modules ARE the source of truth. In-cluster controllers and the CLI are two surfaces over identical code paths. Extends the existing `backend/src/cli/pitr-job.ts` pattern. |
| 19 | Self-upgrade | Daily systemd timer `platform-ops-update.timer` calls `platform-ops self-upgrade --check`. Cosign-verifies before atomic replace. Manual override: `platform-ops self-upgrade --force --version X.Y.Z`. |
| 20 | Defense posture | No daemon. Binary runs as invoking user (root via sudo for privileged ops). No inbound network port. Cosign signature on the binary AND on every container image pulled. |
| 21 | Upgrade compatibility model | **Skip-multiple ALLOWED.** Operator can jump from `installed_platform_version` directly to any newer target; the target image bundles all historic migrations; the runner applies all pending platform-migrations + host-migrations in version order, idempotently. **k3s remains sequential** per Rancher policy; pre-flight splits multi-hop k3s upgrades into N serial SUC Plans. Pre-flight walks the CHANGELOG between installed and target, surfaces EVERY `### BREAKING` in the gap, and requires acknowledgment for each before the run starts — auto-update halts the same way. Every migration MUST be idempotent + self-contained relative to ordering + order-stable. CI guard `scripts/ci-migration-idempotency.sh`. |

### Why these, briefly (decision drivers)

- **CalVer + ad-hoc cadence (6, 2, 9).** A solo-operated hosting platform has no
  marketing release train; "the version is the month it shipped + a patch
  counter" needs no human judgement about MAJOR-vs-MINOR. The breaking-change
  signal that SemVer encodes in the number is moved to where it actually gets
  read at upgrade time: a `### BREAKING` CHANGELOG heading that the auto-update
  path is contractually required to honour.

- **Pull, never push (8, 10, 13, 14).** A cluster that updates itself survives a
  CI outage, a revoked deploy key, and an air-gapped fork. It also collapses the
  "who has write access to prod?" question to "who can click Apply in the admin
  UI?" The `stable` branch and SSH fan-out both exist only to push *into* a
  cluster; both are dropped.

- **TypeScript CLI over Go (17, 18).** The orchestration surface
  (snapshot/restore/migrations/drain) is ~4,000–8,000 LOC of TS that delegates
  heavy work to spawned Kubernetes Jobs. A Go port buys static-binary aesthetics
  at the cost of two perpetually-drifting copies. A `pkg`/`bun`-compiled TS
  binary is equally a single no-daemon cosign-verified file, and the CLI and the
  in-cluster controller become two entrypoints over *one* module set.

- **Skip-multiple with forward-only migrations (21).** The target image carries
  every historic migration; idempotent + order-stable migrations make "apply all
  pending in order" safe regardless of how far behind a cluster is. The only
  sequential constraint is k3s (Rancher refuses skip-a-minor), which pre-flight
  expands into serial SUC Plans. Downgrade is explicitly *not* a migration path —
  it is a snapshot rollback.

- **AGPL-3.0 (1).** Irreversible, so locked here before any source file carries
  the header. For a hosting platform specifically, AGPL closes the
  network-use-without-source loophole that a permissive licence would leave open
  to a closed-source SaaS fork.

---

## Consequences

### Positive

- One artefact (`platform/VERSION`) the UI, Flux, audit log, pre-flight, and
  forks all read; agreement is structural, not coincidental.
- Upgrades, rollback, and DR are observable and operator-gated from the admin
  UI, and *also* available from a CLI that works when the API server is down.
- Forks get a clean on-ramp (`git clone && ./scripts/local.sh up`) with their
  own image org and cosign key; upstream CI never pushes to a fork's registry,
  and a fork's release never auto-applies to an upstream cluster.
- No standing privileged daemon for upgrades/DR: `platform-ops` has zero idle
  attack surface; the only persistent privileged component is the
  allow-listed, cosign-signed host-config DaemonSet.

### Negative / costs

- A privileged host-config DaemonSet and per-node SUC Jobs are real attack
  surface; mitigated by narrow allow-lists, cosign-signed images, an
  integration test asserting non-allow-listed paths are never touched, and a
  nightly diff alert.
- Cosign signature verification is the *only* gate between the GitHub Releases
  feed and an applied upgrade; a mis-pinned or unrotated key is catastrophic.
  The key lives in-repo (`platform/cosign.pub`) and forks MUST replace it.
- CalVer surprises contributors expecting SemVer; `CONTRIBUTING.md` +
  `cut-release.sh`'s interactive prompts absorb the confusion.
- The TS binary trades minor cold-start latency and ~50–80 MB disk for zero code
  duplication — accepted.

### Rejected alternatives

- **SemVer.** Forces a human MAJOR/MINOR/PATCH judgement per release that a
  solo operator does not want to make; the breaking signal is better expressed
  per-change in the CHANGELOG.
- **Push-to-cluster upgrades (ops-runner Job + SSH fan-out).** Original
  `CLUSTER_UPGRADE_ROADMAP.md` Phase 4. Rejected: fails when CI/network is down,
  requires distributed SSH keys, and cannot recover a cluster whose API server
  is unreachable.
- **Pure Go operator binary + shared Go library.** Would re-implement and then
  perpetually maintain a second copy of the orchestration logic. Rejected for
  the direct-TS-import model (Decision 17/18).
- **Keeping the `stable` branch.** Redundant once production Flux pins a tag
  directly and the version-poller re-pins on operator click (Decision 10).
- **Time-boxed release train + drift tracker.** Rejected per operator preference
  for ad-hoc cadence (Decision 2).

---

## Amendments to `CLUSTER_UPGRADE_ROADMAP.md`

This ADR carries forward 17 of that roadmap's 20 locked decisions unchanged
(rollback-in-v1, no migration `down()`, host-config allow-list, k3s
skip-a-minor refusal, tenant-join block during upgrade, rescue-snapshot
retention, super_admin-only rollback, Flux-pinning spike, 60–120s soft freeze,
`oldPlatformApiImageTag` bake-in, cancel-in-progress, 48h staging-soak warning,
`runOnLocal` default, etc. — see holistic plan §9). It amends three:

| Original | Amendment | Reason |
|---|---|---|
| **#2** per-cluster SSH key generated at bootstrap | **DROPPED.** No SSH fan-out in the pull model. SUC spawns per-node Jobs via RBAC; `platform-ops` runs on the node itself for operator-driven failure work. | Pull-model pivot |
| **#4** `platform/VERSION` == git tag `vX.Y.Z` | **AMENDED:** matches git tag `vYYYY.M.PATCH` (CalVer); between tags the file is the last tag while CI computes `<tag>-<sha>` for development. | CalVer (Decision 6) |
| **#18** staging auto-trigger OFF by default | **REVERSED:** staging auto-update **ON**, production **OFF**. | Staging's role is to absorb upgrade risk; auto-update on staging IS the test loop (Decision 7) |

`CLUSTER_UPGRADE_ROADMAP.md` Phase 4 (ops-runner + `bootstrap.sh --upgrade` +
SSH fan-out) is superseded by version-poller + SUC + in-cluster Flux re-pin +
`platform-ops`. The `bootstrap.sh` flags `--upgrade/--rollback/--in-cluster/
--from-version/--to-version` and `scripts/upgrade-paths.yaml` are no longer
planned; bootstrap.sh stays scoped to fresh-install + node-add + platform-ops
install.

---

## Implementation map

Full workstream breakdown, gating graph, PR order, risk register, and success
criteria live in `docs/history/04-deployment/HOLISTIC_RELEASE_AND_UPGRADE_PLAN.md`.
Summary:

- **First independently-valuable artefact:** the version spine (PR 5) — closes
  "I don't know what's deployed" before any upgrade machinery exists.
- **Second:** `platform-ops` scaffolding + snapshot/dr subcommands (PR 9–10) —
  DR-drill capability before any in-cluster upgrade controller is written.
- **Critical path to first prod cutover:** PRs 1, 5, 6, 7, 8, 9, 10, 11, 12,
  12b, 12c, 13, 14, 15, 16, 17, 19, 20.

CI guards introduced along the way: `scripts/preflight-image-org.sh`,
`scripts/ci-no-cluster-push.sh`, `scripts/ci-migration-idempotency.sh`.

---

## References

- `docs/history/04-deployment/HOLISTIC_RELEASE_AND_UPGRADE_PLAN.md` — the implementing roadmap
- `docs/history/04-deployment/CLUSTER_UPGRADE_ROADMAP.md` — amended by this ADR (§6)
- `docs/04-deployment/CICD_PIPELINE_REQUIREMENTS.md` — to be rewritten (W7) to match the pull model
- `docs/history/04-deployment/DR_BUNDLE_ROADMAP.md` — primitives reused by `platform-ops dr`
- calver.org — versioning scheme rationale (Decision 6)
