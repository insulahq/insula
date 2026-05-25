# Holistic Release & Upgrade Plan

**Status:** Plan locked 2026-05-23. Not yet implemented.
**Target:** Ship in tranches before first production cluster cutover.
**Supersedes:** `docs/04-deployment/CLUSTER_UPGRADE_ROADMAP.md` (still authoritative for the 20 locked decisions therein; this document amends some of those — see §10).
**Companion docs:**
- `ROADMAP.md` §"OSS readiness" — three OSS PRs described here as W2–W4
- `docs/04-deployment/CICD_PIPELINE_REQUIREMENTS.md` — to be rewritten in PR 7
- `docs/04-deployment/DR_BUNDLE_ROADMAP.md` — primitives reused by W17's `dr` subcommand

This is the umbrella plan. The original `CLUSTER_UPGRADE_ROADMAP.md` was scoped to cluster upgrade only; this document folds in versioning, release cycle, CI/CD docs, OSS readiness, OS-level convergence, DR, and the operator CLI — because they are coupled around a single artefact (`platform/VERSION`).

---

## 1. Problem Statement

Five concerns surfaced in the 2026-05-23 planning session, all coupled around the version artefact:

1. **No single source of truth for "what version is this cluster running"** — multiple consumers (admin UI, in-cluster Flux, audit log, future upgrade pre-flight, fork operators) infer the version from different surfaces today; none of them agree by construction.
2. **No written release cycle** — `release.yml` exists and fires on `v*.*.*` tags, but nothing documents when a tag should be cut, what SemVer level to bump, how release notes are curated, or how staging soak relates to production cutover.
3. **CI/CD spec is stale** — `docs/04-deployment/CICD_PIPELINE_REQUIREMENTS.md` (1191 lines) references MariaDB, Harbor, NetBird-in-CI, and a Phase 1/2 weeks-1-12 framing that no longer matches the as-built 3-branch GitOps flow.
4. **OSS readiness is documented but not implemented** — `ROADMAP.md` describes three PRs to land after the Traefik migration; nothing has shipped (no `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, image-org preflight, or fork-safe CI guards exist at repo root).
5. **Cluster-upgrade roadmap depends on all four above** — the existing roadmap assumes the version anchor (1), a "v0.6 → v0.7" release unit (2), a current CI/CD reference (3), and an OSS-ready substrate (4). Implementing the upgrade pipeline before these land would bake their absence into the upgrade flow.

A sixth concern emerged during this planning session: **OS-level work that the upgrade pipeline must perform** (sysctls, apt packages, kernel, k3s version, per-release imperative migrations, DR script distribution) was originally scoped via an ops-runner Job + SSH fan-out from the cluster to each node (`CLUSTER_UPGRADE_ROADMAP.md` Phase 4). The operator has explicitly **rejected the push-to-cluster model**: the cluster must pull what it needs, and an operator CLI must work even when k8s is partly or fully down.

This plan addresses all six together.

---

## 2. Architecture — The Version Spine

A single artefact, `platform/VERSION` at the repo root, is the canonical "what version is this code aiming at" value. Everything else is a transformation of, or a check against, that value.

```
                                  platform/VERSION
                                  (one line, e.g. 2026.05.1)
                                          │
                                          ├──── git tag v2026.05.1 ──┐
                                          │                          │
                ┌─────────────────────────┼──────────────────────────┘
                │                         │
            local dev               release.yml on tag
            (sha-suffixed:               • cosign-sign images
             2026.05.1-a3f29bc)          • create GitHub Release
                │                        • image tag = 2026.05.1
                │                        │
                │           ┌────────────┼────────────┐
                │           │            │            │
                │       image LABEL  overlay      GitHub Release
                │       + ENV        patch        notes from CHANGELOG
                │           │            │            │
                │           │            └────► k8s/overlays/development/
                │           │                   platform-version-patch.yaml
                │           │                            │
                │           │                            ▼
                │           │                   platform-version ConfigMap
                │           │                   (in-cluster, namespace=platform)
                │           │                            │
                └───────────┴─────► backend startup reads ConfigMap
                                            │
                       ┌────────────────────┼──────────────────────┐
                       │                    │                      │
                Deployment label    DB row                   /api/admin/platform/version
                (kubectl get)       platform_settings.       endpoint  →  admin UI
                                    installed_platform_      version banner
                                    version                         │
                                            │                       │
                                            ▼                       ▼
                                    gates for: pre-flight,    operator clicks Apply
                                    platform-migration             │
                                    registry, host-migration       │
                                    list, staging-soak warning     ▼
                                                            in-cluster version-poller
                                                            PATCHes Flux Kustomization
                                                            spec.ref.tag → Flux pulls
                                                            → migrations run
                                                            → host-config DS converges
                                                            → SUC Plans roll nodes
```

The fork-safety layer wraps everything: `scripts/preflight-image-org.sh` rewrites `IMAGE_REGISTRY_OWNER` in overlay files so a fork's images come from the fork's GHCR. The release cycle is the cadence on which `platform/VERSION` advances and a tag is cut.

---

## 3. Architecture — Pull-Model Upgrade Flow

Every cluster polls for new versions and applies them itself. No CI workflow pushes TO a cluster.

```
              GitHub Releases API
              (PLATFORM_RELEASES_REPO env, fork-overridable)
                          │
              ┌───────────┴───────────┐
              │     polled hourly     │
              ▼                       ▼
    ┌──────────────────────┐ ┌──────────────────────┐
    │ Development cluster  │ │ Production cluster   │
    │ (Mode A)             │ │                      │
    │                      │ │                      │
    │ Flux watches         │ │ Flux pins specific   │
    │ development branch   │ │ spec.ref.tag         │
    │                      │ │                      │
    │ version-poller:      │ │ version-poller:      │
    │   auto_update=ON     │ │   auto_update=OFF    │
    │   include_prerel=ON  │ │   include_prerel=OFF │
    │                      │ │                      │
    │ → auto-applies on    │ │ → UI banner only;    │
    │   every release      │ │   operator clicks    │
    │   (gated by BREAKING │ │   Apply              │
    │   in CHANGELOG)      │ │                      │
    └──────────────────────┘ └──────────────────────┘
              │                       │
              └───────────┬───────────┘
                          │ apply mechanism (in-cluster, no SSH)
                          ▼
              ┌──────────────────────────────────────┐
              │ 1. PATCH Flux Kustomization          │
              │    spec.ref.tag = "v2026.05.1"       │
              │    → Flux pulls new manifests        │
              │                                      │
              │ 2. platform-migration registry runs  │
              │    (declarative cluster-shape)       │
              │                                      │
              │ 3. host-config DS reconciles new     │
              │    desired state (sysctls, modules,  │
              │    apt packages, host-migrations)    │
              │                                      │
              │ 4. system-upgrade-controller Plans   │
              │    spawn per-node Jobs for k3s /     │
              │    kernel upgrades (nsenter to host) │
              │                                      │
              │ 5. Post-flight gates run             │
              │                                      │
              │ All in-cluster. No SSH. No CI push.  │
              └──────────────────────────────────────┘
```

---

## 4. Architecture — Operator CLI (`platform-ops` TypeScript binary)

For failure modes (cluster partly/fully down), per-node diagnostics, and operator-initiated operations that don't go through the admin UI. **Not a daemon.** **Not a container.** A self-contained TypeScript binary (packaged via `pkg` or `bun build --compile`) that runs on demand. Imports the same backend TS modules the in-cluster controllers use — zero logic duplication.

```
┌──────────────────────────────────────────────────────────┐
│   Node (always installed by bootstrap.sh)                │
│                                                          │
│   /usr/local/bin/platform-ops    (~50–80 MB self-        │
│                                   contained TS binary    │
│                                   produced by pkg or     │
│                                   bun build --compile;   │
│                                   imports backend TS     │
│                                   modules directly)      │
│                                                          │
│   /etc/platform/cosign.pub        (verification key)     │
│   /etc/platform/VERSION           (currently installed)  │
│                                                          │
│   /etc/systemd/system/                                   │
│     platform-ops-update.timer     (fires daily)          │
│     platform-ops-update.service   (oneshot;              │
│                                    cosign-verifies;      │
│                                    atomic replace)       │
│                                                          │
│   Bootstrap-ensured tools on host:                       │
│     kubectl (ships with k3s), age, jq, rsync,            │
│     postgresql-client, openssl, crictl                   │
│                                                          │
│   24/7 idle cost: 0 RAM, ~80 MB disk                     │
│                                                          │
│   Optional: ~500-LOC Go wrapper handles ONLY the         │
│   self-upgrade + cosign-verify loop, for static-binary   │
│   purity on the security-critical bit. The Go wrapper    │
│   chains to the TS binary for all subcommands. Adds      │
│   ~1 week; deferred unless needed.                       │
│                                                          │
│   Subcommands (all run as invoking user; sudo for        │
│   privileged ops):                                       │
│     platform-ops version                                 │
│     platform-ops cluster status                          │
│     platform-ops cluster diagnostics                     │
│     platform-ops migrations list                         │
│     platform-ops migrations apply                        │
│     platform-ops node drain                              │
│     platform-ops node upgrade --version X.Y.Z            │
│     platform-ops snapshot capture|restore|list           │
│     platform-ops dr restore --snapshot <url>             │
│     platform-ops dr rescue                               │
│     platform-ops rollback --to X.Y.Z                     │
│     platform-ops self-upgrade [--version X.Y.Z]          │
│     platform-ops shell                                   │
└──────────────────────────────────────────────────────────┘
```

**Code-sharing**: the CLI entrypoint at `backend/src/cli/platform-ops.ts` directly imports the same TS modules under `backend/src/modules/` that the in-cluster controllers (and existing `backend/src/cli/pitr-job.ts`) use. No shared-library indirection. The modules ARE the source of truth. In-cluster controllers and the CLI are two surfaces over identical code paths.

**Why TypeScript and not Go**: the parallel agent finalising snapshot/backup primitives confirmed that orchestration logic lives canonically in TS modules (heavy work is delegated to spawned Kubernetes Jobs). Porting that surface to Go would mean re-implementing 4,000–8,000 LOC + perpetually maintaining two copies for mostly aesthetic gains. The TS-binary path achieves the same single-static-binary + no-daemon + cosign-verified properties at a fraction of the cost and with zero drift risk.

---

## 5. Locked Decisions (21)

These are settled. Implementation MUST honour them. Changes require an amendment to this document.

| # | Topic | Decision |
|---|---|---|
| 1 | LICENSE | **AGPL-3.0**. Strongest copyleft; mirrors Plausible/Mastodon/Nextcloud; prevents closed-source SaaS forks of a hosting platform. |
| 2 | Release cadence | **Ad-hoc**. No time-boxed schedule. Operator cuts a tag when accumulated changes warrant a release. Drift-tracker workflow explicitly skipped. |
| 3 | Pre-release identifier | **`-rc.N`** only. No `-beta.N` distinction. |
| 4 | `CICD_PIPELINE_REQUIREMENTS.md` disposition | **Rewrite in place**. Historical phase framing not load-bearing; replace with as-built spec. |
| 5 | `platform/VERSION` between tags | **Pinned to last released tag**. Between tags the file says `2026.05.1` while CI computes `2026.05.1-<sha>` for staging. `cut-release.sh` is the only thing that edits the file. |
| 6 | Versioning scheme | **CalVer `YYYY.0M.PATCH`** (e.g. `2026.05.1`). Leading-zero month for lexical sort stability. PATCH starts at `.1` per calver.org. Breaking-change signal preserved via `### BREAKING` heading in CHANGELOG; auto-update refuses to auto-apply any release whose CHANGELOG section contains `BREAKING`. |
| 7 | Auto-update defaults | **Staging ON, production OFF, local clusters N/A** (button hidden). Stored in `platform_settings.upgrade.auto_update_enabled`. |
| 8 | Release feed source | **GitHub Releases API** of `PLATFORM_RELEASES_REPO` env (default `insulahq/hosting-platform`, fork-overridable). **Cosign signature** on release artifacts verified before any apply. Public key pinned in `platform/cosign.pub` checked into the repo. Fork operators MUST replace this key with their own. |
| 9 | Release tagging | **Manual only** via `scripts/cut-release.sh`. No auto-promote from staging/main. |
| 10 | `stable` branch | **DROP**. `release.yml` stops opening PRs to stable. Production Flux pins `spec.ref.tag` directly; version-poller re-pins on operator click. |
| 11 | Pre-releases | `cut-release.sh --prerelease` produces `YYYY.0M.PATCH-rc.N`. GitHub Release `prerelease=true`. Separate flag `auto_update_include_prereleases` (default ON staging / OFF prod). |
| 12 | Staging cluster mode | **Mode A only Phase 1**. Mode A = Flux watches `development` branch tip (every-commit bleeding-edge smoke). Mode B (Flux pins latest `-rc.N` tag) is a deferred future option. |
| 13 | Branch naming | Rename `staging` → `development`. **No new `staging` branch**. "Staging cluster" survives as a cluster-role name only. Tags carry all release semantics. |
| 14 | OS-level changes strategy | Three complementary mechanisms: (a) **continuous reconciler** for declarative drift (sysctls, modules, ulimits, declared apt packages); (b) **per-release host-migration runner** for one-shot imperative scripts; (c) **operator CLI** for failure-mode and ad-hoc work. Operator NEVER manually re-bootstraps for a non-BREAKING release. |
| 15 | DR ownership | **No standalone DR script.** DR is absorbed into the `platform-ops` binary as `platform-ops dr restore`. `dr-drill.yml` extended to exercise this path. |
| 16 | Host-migration safety | Each migration is recorded per-node in a ConfigMap. Halts on first failure. Operator-resumable via UI. Surfaces in pre-flight before any Apply click. Shell migrations linted by shellcheck in CI. |
| 17 | Operator CLI surface | **TypeScript binary** packaged via `pkg` (or `bun build --compile`), ~50–80 MB self-contained, at `/usr/local/bin/platform-ops`. **No container, no daemon.** Installed and cosign-verified by bootstrap.sh on first run. Optional ~500-LOC Go wrapper handles ONLY the self-upgrade + cosign-verify loop for static-binary purity on the security-critical bit; deferred unless needed. Revised from "pure Go binary" on 2026-05-23 after the parallel agent confirmed orchestration logic lives canonically in TypeScript modules — Go would mean re-implementing 4,000–8,000 LOC and maintaining two copies forever. |
| 18 | Code-sharing | CLI entrypoint at `backend/src/cli/platform-ops.ts` **directly imports** the backend TS modules under `backend/src/modules/`. No shared-library indirection; the modules ARE the source of truth. In-cluster controllers and the CLI are two surfaces over identical code paths. Pattern extends the existing `backend/src/cli/pitr-job.ts`. |
| 19 | Self-upgrade | Daily systemd timer `platform-ops-update.timer` calls `platform-ops self-upgrade --check`. Cosign-verifies before atomic replace. Manual override: `platform-ops self-upgrade --force --version X.Y.Z`. |
| 20 | Defense posture | No daemon. Binary runs as invoking user (root via sudo for privileged ops). No inbound network port. Cosign signature on binary AND on every container image we pull. |
| 21 | **Upgrade compatibility model** | **Skip-multiple ALLOWED**. Operator can jump from `installed_platform_version` directly to any newer target; the target image bundles all historic migrations; runner applies all pending platform-migrations + host-migrations in version order, idempotently. **k3s remains sequential** per Rancher policy (`CLUSTER_UPGRADE_ROADMAP.md` locked decision #8); pre-flight splits multi-hop k3s upgrades into N serial SUC Plans. **Pre-flight UI walks the CHANGELOG between installed and target**, surfaces EVERY `### BREAKING` heading in the gap, and requires acknowledgment for each before the run starts — auto-update halts the same way. Every migration MUST be idempotent + self-contained relative to ordering + order-stable. CI guard `scripts/ci-migration-idempotency.sh` lints platform-migrations + shellchecks host-migrations. See §14 for full operator-experience walkthrough. |

---

## 6. Workstreams

Numbered W0–W17. Independently shippable workstreams are marked; gating relationships are explicit.

### W0 — Decision lock (no code)
**Goal**: ADR-042 captures all 20 decisions before any implementation PR.
**Deliverables**: `docs/07-reference/ADR-042-versioning-release-cycle-and-upgrade.md`.
**Dependencies**: None.
**Complexity**: L. **Risk**: L.
**Shippable independently**: yes.

### W1 — Branch rename (`staging` → `development`)
**Goal**: Naming matches reality. "Staging cluster" remains a cluster-role name; the branch role becomes `development`.
**Deliverables**: rename via git operation + create `development` branch from current `staging`; rename `sync-staging.yml` → `sync-development.yml`; update target branch references in `build-deploy.yml`; rename `k8s/overlays/staging/` → `k8s/overlays/development/`; update Flux GitRepository on every live staging cluster (operator chore, documented in PR); keep old `staging` branch as deprecation pointer for ~2 weeks; update docs and memory.
**Dependencies**: W0 (decision 13 locked).
**Complexity**: M.
**Risk**: M (cross-cutting; touches live cluster Flux specs).

### W2 — OSS PR1: image-org preflight + CI fork-safety
**Goal**: Fork's `git clone && ./scripts/local.sh up` works without overlay edits; PR-from-fork CI runs tests without push secrets.
**Deliverables**: `scripts/preflight-image-org.sh`; audit all 19 workflow files for hardcoded `insulahq`; `if: github.repository == 'insulahq/hosting-platform'` guards on push-side workflows; `pull_request` vs `pull_request_target` review; GHCR package public-visibility confirmation.
**Dependencies**: W0.
**Complexity**: M.
**Risk**: M (getting `pull_request_target` wrong opens malicious-fork-PR attacks).

### W3 — OSS PR2: contributor docs
**Goal**: Real OSS-project presentation.
**Deliverables**: top-level README rewrite (5-min on-ramp + mermaid arch diagram); `LICENSE` (AGPL-3.0); `CONTRIBUTING.md` (incl. SemVer-bump heuristics for CalVer + ad-hoc cadence); `SECURITY.md` (vuln disclosure policy); `.github/ISSUE_TEMPLATE/`; `.github/PULL_REQUEST_TEMPLATE.md`; `docs/04-deployment/FORK-AND-DEPLOY.md`.
**Dependencies**: W0 (LICENSE choice).
**Complexity**: M (writing-heavy).
**Risk**: L.

### W4 — OSS PR3: per-component READMEs
**Goal**: Each subdir developable in isolation.
**Deliverables**: `backend/README.md`, `frontend/admin-panel/README.md`, `frontend/tenant-panel/README.md`, `packages/api-contracts/README.md` (document `tsc --build --force` requirement). Architecture diagram in top-level README.
**Dependencies**: W0.
**Complexity**: L.
**Risk**: L.

### W5 — Version spine
**Goal**: The §2 diagram becomes real.
**Deliverables**: `platform/VERSION` file (CalVer); `release.yml` cut-tag job validates file matches `${GITHUB_REF_NAME#v}`; `build-deploy.yml` keeps writing `${LAST_TAG}-${SHORT_SHA}` to development overlay + adds `platform.example.test/version` label on the three Deployments; bootstrap.sh + scripts/local.sh write `platform-version` ConfigMap idempotently; backend startup persists `platform_settings.installed_platform_version`; `GET /api/admin/platform/version` returns `{ installed, available, running }`; admin UI version banner across all admin pages when `available > installed`.
**Dependencies**: W0, W1 (overlay directory name).
**Complexity**: M.
**Risk**: L.

### W6 — Release cycle automation (manual cut, ad-hoc cadence)
**Goal**: Operator can cut a release with one command. SemVer-bump heuristics codified.
**Deliverables**: `CHANGELOG.md` at repo root (Keep-a-Changelog format + `### BREAKING` heading convention); `scripts/cut-release.sh` (interactive: prompts year/month/patch + `--prerelease` flag + breaking-flag; pre-fills CHANGELOG entry from conventional commits; updates `platform/VERSION` + CHANGELOG; creates annotated tag); `release.yml` extended to parse CHANGELOG section for the tag as the GitHub Release body (replaces `generate_release_notes: true`); **`update-production-tags` job in `release.yml` is DELETED** (drops the PR-to-stable step); `RELEASING.md` at root.
**Dependencies**: W0, W5.
**Complexity**: M.
**Risk**: L.

### W7 — CICD spec doc rewrite
**Goal**: `docs/04-deployment/CICD_PIPELINE_REQUIREMENTS.md` matches as-built.
**Deliverables**: rewrite in place. Remove MariaDB / Harbor / NetBird-in-CI / Phase 1-2 weeks framing. Add: 3-branch GitOps reality, per-component CI matrix (19 `ci-*.yml` workflows), version spine, pull-model upgrade architecture, "no push-to-cluster" rule + `scripts/ci-no-cluster-push.sh` guard.
**Dependencies**: W1 (correct branch names), W5.
**Complexity**: M (writing-heavy).
**Risk**: L.

### W8 — Bootstrap phase library + platform-ops install
**Goal**: bootstrap.sh becomes a thin orchestrator; first install lays down `platform-ops` binary.
**Deliverables**: extract phase functions into `scripts/lib/bootstrap-phases.sh` (`phase_k3s`, `phase_flux`, `phase_calico`, `phase_longhorn`, `phase_cnpg`, `phase_stalwart`, …); each function idempotent. bootstrap.sh end-of-run installs `platform-ops` binary at `/usr/local/bin/`, cosign-verifies, writes `/etc/platform/cosign.pub`, installs the systemd timer.
**Dependencies**: W5 (VERSION available for the install).
**Complexity**: M-H. Risk of regressing fresh-install.
**Risk**: M. Mitigation: re-run fresh-bootstrap on `testing.example.test` end-to-end.

### W9 — Platform-migration registry
**Goal**: Roadmap Phase 2. Drizzle-style declarative cluster migrations, run at backend startup. Supports skip-multiple by applying all pending migrations in version order on every startup (Locked decision #21).
**Deliverables**: DB migration `0XXX_platform_migrations.sql`; `backend/src/modules/platform-upgrades/migrations/` directory; `runner.ts` with Postgres advisory lock + dry-run mode + checksum drift detection; wired into `backend/src/index.ts` startup after Drizzle, before HTTP listen; `PLATFORM_SKIP_MIGRATIONS=1` escape hatch; seed migration `0001_v2026_05_seed_host_config_reconciler.ts`; seed migration `0002_v2026_05_record_baseline.ts` (k3s/calico/longhorn versions to `platform_baselines` table). **Migration authoring discipline (enforced by `scripts/ci-migration-idempotency.sh`)**: every migration MUST be idempotent (re-run is a no-op), self-contained relative to ordering (depends only on previously-numbered migrations, never on a specific source version), and order-stable (a shipped migration's position is its contract — renaming/renumbering forbidden). CI guard parses each migration for forbidden patterns (e.g. `DROP COLUMN IF EXISTS` is OK; `DROP COLUMN` without guard is not).
**Dependencies**: W5, W8.
**Complexity**: H.
**Risk**: M (startup-blocking; mitigated by dry-run + escape hatch + idempotency discipline).

### W10 — host-config-reconciler DS base (sysctls/modules/ulimits)
**Goal**: Roadmap Phase 3. Continuous convergence; delivered as the first platform-migration to dogfood W9.
**Deliverables**: `k8s/base/host-config-reconciler/{daemonset,rbac,kustomization}.yaml`; shape modeled on `k8s/base/firewall-reconciler/`; privileged + hostPID + hostNetwork + mounts `/etc`, `/proc/sys`, `/lib/modules`. Desired state in `host-config-desired` ConfigMap (sysctls map, kernel modules list, ulimits map, fs.inotify caps, `/etc/security/limits.d/*`). 60s reconcile loop. Allow-list enforced in code; integration test asserts non-allow-listed paths untouched. Image cosign-signed. Nightly diff alert.
**Dependencies**: W9 (delivered as a migration), W2 (image-org preflight).
**Complexity**: H.
**Risk**: H. Privileged DS attack surface.

### W10b — host-config DS: apt/dnf package convergence
**Goal**: Declared packages always present.
**Deliverables**: extend reconciler with `host-packages-desired` ConfigMap (entries: package name + optional pinned version). Reconciler diffs current vs declared; runs apt/dnf via host namespace. Serial across nodes (SUC-style drain coordination).
**Dependencies**: W10.
**Complexity**: M.
**Risk**: M (slow apt mirror stalls cluster; per-node timeout + failure→halt).

### W10c — host-config DS: host-migration runner
**Goal**: Per-release one-shot imperative scripts (Locked decisions #14 + #21). Supports skip-multiple — when a node's `applied-host-migrations` ConfigMap shows it has fallen behind by N migrations, the runner walks the entire pending set in version order on that node.
**Deliverables**: extend reconciler with `host-migrations/<version>/*.sh` directory shipped via release manifests; per-node `applied-host-migrations` ConfigMap records completion (entries keyed by `<version>/<script-name>`); halts on first failure; operator-resumable; shellcheck CI guard (part of `scripts/ci-migration-idempotency.sh`); per-script narrow allow-list of paths (any deviation requires `### BREAKING` heading in CHANGELOG). **Host-migration authoring discipline**: idempotent (re-running a script on a node where it already applied is a no-op; use marker files in `/var/lib/platform/host-migrations/` if needed); self-contained relative to ordering (script `2026-06-004-foo.sh` may assume `2026-05-007-bar.sh` has run, but never that "we were on version X when this runs"); order-stable.
**Dependencies**: W10, W9.
**Complexity**: H.
**Risk**: H. Mitigated by dry-run on control-plane first; serial; rescue snapshot still applies.

### W11 — Version-poller + GH Releases fetch + cosign verify
**Goal**: Cluster polls for new releases; surfaces in admin UI.
**Deliverables**: hourly CronJob in `platform` namespace; calls GitHub Releases API of `PLATFORM_RELEASES_REPO`; cosign-verifies; writes `platform_settings.available_version`; honours `auto_update_include_prereleases` flag.
**Dependencies**: W5, W8.
**Complexity**: M.
**Risk**: M (malicious release → cosign-verify is the only gate; key must be pinned correctly).

### W11.5 — platform-ops self-upgrade loop + cluster-down fallback
**Goal**: Binary keeps itself current.
**Deliverables**: `platform-ops self-upgrade [--check] [--force] [--version X.Y.Z]` subcommand; daily systemd timer; cluster-up path reads `platform-version` ConfigMap; cluster-down fallback queries GHCR API; cosign-verifies; atomic replace.
**Dependencies**: W11, W9.5 (platform-ops scaffolding).
**Complexity**: M.
**Risk**: L.

### W12 — system-upgrade-controller integration
**Goal**: k3s + kernel + apt upgrades via in-cluster Plans (no SSH).
**Deliverables**: deploy SUC in `system-upgrade` namespace; Plan-CR template generator in `pkg/platformops/operations/`; integration test for k3s skip-a-minor refusal (locked decision #8 from `CLUSTER_UPGRADE_ROADMAP.md`); cosign-signed SUC image; RBAC limited to node-upgrade verbs.
**Dependencies**: W11, W10.
**Complexity**: H.
**Risk**: H (privileged Jobs on every node; mitigated by upstream-battle-tested SUC + allow-list).

### W13 — In-cluster Flux Kustomization tag re-pinning + auto-update reconciler
**Goal**: The cluster updates its own Flux source revision in-cluster (no external push).
**Deliverables**: reconciler that PATCHes `Kustomization.spec.ref.tag` when `auto_update_enabled=true` AND `available > installed` AND BREAKING-gate passes AND pre-flight passes; `platform-api` sidecar with OLD image baked in at upgrade-time (chicken-and-egg fix; matches `CLUSTER_UPGRADE_ROADMAP.md` locked decision #16).
**Dependencies**: W11, W12.
**Complexity**: H.
**Risk**: H (validated by W16 spike before merge).

### W13.5 — platform-ops upgrade/node-drain subcommands
**Goal**: CLI parity with admin UI for upgrade operations.
**Deliverables**: `platform-ops node drain|uncordon|upgrade`, `platform-ops cluster upgrade --version X.Y.Z`; shell out to same operations library as W13.
**Dependencies**: W13.
**Complexity**: M.
**Risk**: L.

### W14 — Pre/post-flight gates + admin UI
**Goal**: Roadmap Phase 5. Observable, gated, undoable from UI.
**Deliverables**: `preflight.ts` (CNPG health, Longhorn replicas ≥2, no in-flight tenant migrations, Flux suspended status, snapshot age <24h or take fresh, disk >20%, k3s skip-a-minor check, snapshot capture itself succeeds, per-gate operatorError, severity driven by `K8S_ENVIRONMENT_KIND`); `postflight.ts` (nodes Ready, CNPG primary elected, Stalwart `/admin/mail/health` green, ingress 200, backend deep-health, 3-consecutive-fails → automatic phase abort); `auto-trigger.ts` (off by default for production); admin UI: version banner, `/platform/upgrades` page (installed/available, pending platform-migrations, pending host-migrations, phase plan, pre-flight results, soft-warning yellow vs hard-block red), run modal hooked into task-center via target `modal:platform-upgrade-apply`, cancel button with extra-confirmation (locked decision #17 in `CLUSTER_UPGRADE_ROADMAP.md`); production "Staging soak status" row (git-derived, read-only).
**Dependencies**: W11, W13.
**Complexity**: M-H.
**Risk**: M.

### W15 — (absorbed into W17 — see Locked Decision #15)
DR script does not exist as a standalone workstream; `platform-ops dr restore` subcommand IS the DR mechanism.

### W16 — Snapshot-restore rollback + rescue-snapshot + UI
**Goal**: Roadmap Phase 6. Snapshot-restore-based rollback, operator-resumable.
**Spike first**: validate in-cluster Flux tag-repinning + SUC rollback behaviour (does the cluster's Flux Kustomization re-pin behave when the controller doing the re-pinning is itself part of what's being rolled back?). Goes/no-goes the design of the implementation.
**Deliverables**: `UpgradeSnapshotManifest` TypeScript shape; migration `0107_platform_upgrade_snapshots.sql`; `backend/src/modules/platform-upgrades/longhorn-snapshot.ts`; mandatory rescue snapshot before any destructive step; soft freeze (60-120s) during snapshot capture (locked decision #15 in `CLUSTER_UPGRADE_ROADMAP.md`); rollback endpoints (super_admin only); rollback subcommand for `platform-ops`; UI "Rollback this upgrade" button; rollback enters `paused` on 3-consecutive-fails post-flight.
**Dependencies**: W13, W14.
**Complexity**: H.
**Risk**: H.

### W17 — platform-ops binary (umbrella; spans multiple PRs)
**Goal**: The operator CLI from §4. Pulled forward in delivery order — CLI scaffolding (PR 9, previously PR 9.5) becomes critical-path so the operator has failure-mode tooling from day-1 and the parallel agent's snapshot/backup primitives can be wrapped immediately.
**Deliverables**: TypeScript entrypoint `backend/src/cli/platform-ops.ts` that directly imports `backend/src/modules/`; `scripts/build-platform-ops.sh` produces a self-contained binary via `pkg` (or `bun build --compile`) at `/usr/local/bin/platform-ops`; subcommands shipped in tranches (status/version/shell/diagnostics first, then snapshot/dr wrapping parallel agent's primitives, then self-upgrade, then upgrade/drain, then rollback); cosign-signed release artifacts uploaded by `release.yml` as GitHub Release assets; daily systemd timer; bootstrap.sh installs on first run. Optional follow-up: ~500-LOC Go self-upgrade wrapper for static-binary purity on the security-critical bit.
**Dependencies**: W5, W8. Most subcommand PRs depend on the corresponding module having landed (snapshot subcommand depends on parallel agent's primitives; upgrade subcommand depends on W13; etc.).
**Complexity**: H (umbrella).
**Risk**: M (concentrated privilege but no worse than today's k3s admin kubeconfig + root SSH posture). TypeScript binary trades minor cold-start latency and binary size for zero code duplication.

---

## 7. Independently Shippable vs Gating

**Independently shippable**: W0, W1, W2, W3, W4, W6, W7, W8.

**Gates**:
- W5 gates W9–W17 (the version spine is the anchor).
- W8 gates W9, W10, W17 (bootstrap stability is the substrate).
- W9 gates W10 (dogfooding), W11 (migration registry feeds the poller).
- W10 gates W10b, W10c (extensions to the same DS).
- W11 gates W11.5, W12, W13.
- W13 gates W14, W16.
- W16 spike gates W16 implementation.

---

## 8. PR Delivery Order

20 PRs (revised from 22 after 2026-05-23 update — CLI moved to critical path; controller+CLI pairs collapsed into single PRs since both surfaces import the same TS module). Each self-contained — even if the next slips indefinitely, what landed is useful.

| # | PR title | Workstream | Complexity |
|---|---|---|---|
| **PR 1** | `docs(adr): ADR-042 — 20 versioning/release/upgrade/CLI decisions` | W0 | L |
| **PR 1.5** | `chore: rename staging branch → development; staging cluster role unchanged` | W1 | M |
| **PR 2** | `feat(oss): image-org preflight + CI fork-safety guards` | W2 | M |
| **PR 3** | `docs(oss): LICENSE (AGPL-3.0), CONTRIBUTING, SECURITY, README rewrite, templates` | W3 | M |
| **PR 4** | `docs(oss): per-component READMEs + architecture diagram` | W4 | L |
| **PR 5** | `feat(platform): version spine — platform/VERSION → ConfigMap → label → DB → API` | W5 | M |
| **PR 6** | `feat(release): CHANGELOG (CalVer + BREAKING convention) + cut-release.sh + RELEASING.md; drop stable-PR job from release.yml` | W6 | M |
| **PR 7** | `docs(cicd): rewrite CICD_PIPELINE_REQUIREMENTS.md to match as-built pull-model` | W7 | M |
| **PR 8** | `refactor(bootstrap): extract scripts/lib/bootstrap-phases.sh + install platform-ops TS binary on first run` | W8 | M-H |
| **PR 9** | `feat(platform-ops): TS-binary scaffolding + status/version/shell/diagnostics/migrations-list subcommands; pkg-compile pipeline; cosign signing in release.yml` | W17 | M-H |
| **PR 10** | `feat(platform-ops): snapshot capture/list/restore + dr restore/rescue subcommands wrapping parallel agent's primitives` | W17 | M |
| **PR 11** | `feat(upgrade-p2): platform-migration registry + runner + dry-run + advisory lock; controller invokes platform-ops migrations apply` | W9 | H |
| **PR 12** | `feat(upgrade-p3): host-config-reconciler DaemonSet (sysctls/modules/ulimits) — seed migration` | W10 | H |
| **PR 12b** | `feat(host-config): apt/dnf package convergence via host-packages-desired ConfigMap` | W10b | M |
| **PR 12c** | `feat(host-config): host-migration runner (per-release one-shot scripts)` | W10c | H |
| **PR 13** | `feat(version-poller): hourly GitHub Releases fetch + cosign verify + available_version persistence` | W11 | M |
| **PR 14** | `feat(platform-ops): self-upgrade loop + cluster-down fallback + systemd timer (optional Go wrapper deferred)` | W17/W11.5 | M |
| **PR 15** | `feat(upgrade-p4-host): system-upgrade-controller integration + platform-ops node upgrade subcommand` | W12 | H |
| **PR 16** | `feat(upgrade-p4-flux): in-cluster Flux Kustomization tag re-pinning + platform-ops upgrade apply subcommand` | W13 | H |
| **PR 17** | `feat(upgrade-p5): pre/post-flight gates + /platform/upgrades admin UI + host-migration preview` | W14 | M-H |
| **PR 18** | `spike(upgrade-p6): validate in-cluster Flux re-pinning + SUC rollback behaviour` | W16 spike | L |
| **PR 19** | `feat(upgrade-p6): snapshot-restore rollback + rescue-snapshot + UI + platform-ops rollback subcommand` | W16 | H |
| **PR 20** | `feat(ci): scripts/ci-no-cluster-push.sh guard (CLI/UI parity guard no longer needed — single source TS modules)` | W17 final + W7 | L |

**First independently-valuable artefact**: PR 5 (version spine). Closes the "I don't know what's deployed" pain even before any upgrade machinery lands. **Second**: PR 9 + PR 10 give the operator a working CLI that wraps backup/snapshot primitives — DR drill capability exists before any in-cluster upgrade controller is written.

**Critical-path subset for "ready for first prod cutover"**: PR 1, 5, 6, 7, 8, 9, 10, 11, 12, 12b, 12c, 13, 14, 15, 16, 17, 19, 20.

**Why the renumber**: pulling W17 (CLI) earlier with TS-native shared modules means controller+CLI pairs (W12/W13.5, W13/W11.5, W16/W16.5) collapse into single PRs (each operation is a single TS module imported by both controller and CLI). Saves ~3-4 weeks net and means the failure-mode/DR-recovery surface exists from PR 10 onward, not PR 16.5.

---

## 9. Locked Decisions Carried Forward from `CLUSTER_UPGRADE_ROADMAP.md`

The 2026-05-15 roadmap locked 20 decisions in its §3. This document **amends three** (see §10) and **carries the rest forward unchanged**:

- #1 rollback in v1 (snapshot-restore-based) — preserved (W16)
- #3 Phase 0 bootstrap-bug fixes land standalone — already done organically (commits `82b3a29a`, `e0777f59`, `e8326bd0`, `df88526e`, `8df7e34a`)
- #5 no migration `down()` functions — preserved (W9)
- #6 host-config allow-list — preserved as **base allow-list**; W10b/c extensions have their own narrower allow-lists with `### BREAKING` requirement for paths outside
- #7 first seed migration = host-config-reconciler — preserved (W10 delivered via W9)
- #8 k3s skip-a-minor REFUSE — preserved (W14 preflight)
- #9 tenant join blocked during upgrade with `UPGRADE_IN_PROGRESS` — preserved (W14)
- #10 first prod bootstraps onto skeleton-aware version — preserved (PR 1-14 land before first prod cutover)
- #11 5 snapshot retention, configurable — preserved (W16)
- #12 rescue snapshot retention indefinite — preserved (W16)
- #13 rollback super_admin only — preserved (W16)
- #14 Flux pinning spike before implementation — preserved (PR 15)
- #15 60-120s soft freeze during snapshot — preserved (W16)
- #16 `oldPlatformApiImageTag` baked into upgrade-time controller — preserved (W13)
- #17 cancel-in-progress + UI extra-confirmation — preserved (W14)
- #19 48h staging-soak warning — preserved (W14, git-log-derived)
- #20 migration `runOnLocal` default true — preserved (W9)

---

## 10. Amendments to `CLUSTER_UPGRADE_ROADMAP.md`

| Original | Amendment | Reason |
|---|---|---|
| **#2** per-cluster SSH key, generated at bootstrap, distinct from operator key | **DROPPED**. No SSH fan-out in pull model. system-upgrade-controller spawns per-node Jobs via RBAC + ServiceAccount; `platform-ops` runs on the node itself for operator-driven failure-mode work. | Pull-model architectural pivot |
| **#4** `platform/VERSION` same value as git tag `vX.Y.Z` | **AMENDED**: `platform/VERSION` matches git tag `vYYYY.0M.PATCH` (CalVer); between tags the file says e.g. `2026.05.1` while CI computes `2026.05.1-<sha>` for the development cluster. | Versioning scheme change |
| **#18** Staging auto-trigger OFF by default | **REVERSED**: Staging auto-update **ON** by default; production **OFF**. | Staging's role is to absorb risk; auto-update on staging is the test loop |

Phase 4 of `CLUSTER_UPGRADE_ROADMAP.md` (ops-runner Job + `bootstrap.sh --upgrade` + SSH fan-out) is **superseded** by W11 (version-poller) + W12 (SUC) + W13 (in-cluster Flux re-pin) + W17 (platform-ops CLI). The `bootstrap.sh` flags `--upgrade`, `--rollback`, `--in-cluster`, `--from-version`, `--to-version`, and the file `scripts/upgrade-paths.yaml` are no longer planned. bootstrap.sh stays scoped to fresh-install + node-add + platform-ops install.

---

## 11. Risk Register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | LICENSE choice irreversible | H | Locked in ADR-042 (W0) before any PR ships AGPL header |
| 2 | Fork-PR CI pushes to upstream GHCR | H | W2: audit 19 workflows; explicit repo-owner guards; prefer `pull_request` over `pull_request_target` |
| 3 | Privileged host-config DS attack surface | H | W10: allow-listed paths; cosign-signed image; integration test asserts non-allow-listed paths unmodified; nightly diff alert |
| 4 | Privileged platform-ops binary attack surface | M | No daemon (no idle attack surface); cosign signature on every self-upgrade; same posture as today's k3s admin kubeconfig + root SSH |
| 5 | Version-poller pulls malicious release | H | Cosign signature verification (Decision 8); public key pinned in `platform/cosign.pub`; fork operators MUST replace key |
| 6 | Auto-update applies BREAKING release on staging unnoticed | M | `### BREAKING` CHANGELOG heading short-circuits auto-update; UI banner persists; bell-icon notification per auto-applied run |
| 7 | SUC blast radius (privileged Jobs per-node) | H | Same allow-list discipline as host-config DS; cosign-signed SUC image; RBAC limited to node-upgrade verbs; upstream battle-tested |
| 8 | `platform-api` self-rollback chicken-and-egg | M | Sidecar with OLD image baked at upgrade-time (locked decision #16 in roadmap); validate in PR 15 spike |
| 9 | First prod cutover has no battle-testing | H | Rehearse v2026.06→v2026.07 twice on prod-shaped staging clone; freeze upgrades 2 weeks after first prod cutover |
| 10 | Migration N+1 fails mid-fleet | H | Idempotent migrations; runner halts on failure; mandatory pre-snapshot; advisory lock |
| 11 | Host-migration script bug bricks a node | H | Dry-run on control-plane first; halts on first failure; rescue snapshot still applies (W16) |
| 12 | Ad-hoc cadence drifts to "never cut a release" | M | Mitigated by UI version banner showing commits-since-last-tag; no drift-tracker per operator preference |
| 13 | `bootstrap.sh` regresses fresh-install during W8 extraction | M | Re-run fresh-bootstrap on `testing.example.test` end-to-end per W8 validation |
| 14 | platform-ops binary drift on a node where self-upgrade timer fails | L | Version-stamp + admin UI surfaces "platform-ops out of date on node X"; CLI startup warns |
| 15 | Operator confusion: admin UI vs CLI | L | Docs: admin UI = normal ops, CLI = failure modes + diagnostics + per-node work |
| 16 | Existing forks pinned to `stable` branch break when we drop it | L | Keep `stable` branch as frozen pointer for one release cycle; document migration in CHANGELOG `### BREAKING` for the release that introduces the new flow |
| 17 | Slow apt mirror stalls node-by-node rollout | M | SUC's per-node serialisation + per-node timeout + failure→halt with operator-resume |
| 18 | DR script (now `platform-ops dr restore`) untested in real DR | H | `dr-drill.yml` extended to exercise the subcommand; quarterly DR drill |
| 19 | Snapshot+upgrade race | M | Soft freeze 60-120s (locked decision #15) |
| 20 | CalVer adoption confuses contributors used to SemVer | L | ADR-042 + CONTRIBUTING.md explain; cut-release.sh walks the operator through |

---

## 12. Success Criteria

The holistic plan is delivered when:

- [ ] ADR-042 captures all 20 locked decisions and is merged.
- [ ] `LICENSE` (AGPL-3.0), `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `RELEASING.md`, `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`, and rewritten top-level `README.md` are present at the repo root.
- [ ] Fresh clone of a fork on a clean machine runs `./scripts/local.sh up` successfully without manual overlay edits.
- [ ] PR-from-fork CI runs the test gate on `pull_request` without `secrets.*` exposure; push-side jobs skip cleanly.
- [ ] `platform/VERSION` value is identical across: repo file, image env, `platform-version` ConfigMap, `platform-api` Deployment label, and `platform_settings.installed_platform_version` DB row.
- [ ] `GET /api/admin/platform/version` returns `{ installed, available, running }`; admin UI version banner appears when `available > installed`.
- [ ] `scripts/cut-release.sh` produces a clean tagged release end-to-end (CHANGELOG move + VERSION bump + tag + release.yml fires + GitHub Release with curated notes).
- [ ] `release.yml` no longer opens a PR to `stable` branch; `stable` branch deprecated.
- [ ] `staging` branch renamed to `development`; all CI references updated; live Flux GitRepository specs updated.
- [ ] `docs/04-deployment/CICD_PIPELINE_REQUIREMENTS.md` describes the actually-running pull-model 3-branch GitOps pipeline; no references to MariaDB, Harbor, NetBird-in-CI, or `stable` branch remain.
- [ ] Fresh-bootstrap on a single-node Debian 13 host succeeds end-to-end with extracted `scripts/lib/bootstrap-phases.sh`; bootstrap.sh installs `platform-ops` binary + cosign key + systemd timer.
- [ ] `platform-ops` binary statically links, ~30-50 MB, cosign-verifies on self-upgrade.
- [ ] Backend startup runs unfulfilled platform-migrations in order; refuses HTTP listen on failure; dry-run + escape hatch verified.
- [ ] Host-config DS converges sysctl drift within 60s on a manually-broken `/etc/sysctl.d/99-platform.conf`; non-allow-listed paths never modified.
- [ ] Host-packages-desired ConfigMap entry triggers apt install on every node; failure halts rollout with operator-resumable state.
- [ ] Host-migration runner records per-node application; halts on first failure; resumable.
- [ ] Version-poller fetches GH Releases hourly; cosign-verifies; writes `available_version`.
- [ ] In-cluster Flux Kustomization re-pinning works for v2026.06→v2026.07 on the development cluster; PR 15 spike result documented.
- [ ] SUC Plans roll k3s version one node at a time; serial drain.
- [ ] Super_admin triggers a v2026.06→v2026.07 upgrade run on staging from admin UI; pre-flight, snapshot, in-cluster Flux re-pin, post-flight, audit log all behave; tenant create returns `UPGRADE_IN_PROGRESS` during the run.
- [ ] `platform-ops cluster status` works when the cluster is healthy AND when the API server is down.
- [ ] `platform-ops dr restore` rebuilds a destroyed cluster from a snapshot in the `dr-drill.yml` harness.
- [ ] Rollback API + UI button work for `succeeded`, `failed`, `partial_success` runs while snapshot exists; rescue snapshot always taken before destructive steps.
- [ ] Concurrent upgrade↔rollback impossible (advisory lock covers both).
- [ ] `scripts/ci-no-cluster-push.sh` rejects any new `.github/workflows/*.yml` that contains write-verb kubectl/helm/flux against a cluster context.
- [ ] `scripts/ci-platform-ops-parity.sh` asserts every controller operation has a corresponding CLI subcommand (or explicit exemption annotation).

---

## 13. Out of Scope (v1)

- Automatic rollback to N-1 without operator click.
- Multi-cluster fan-out (one upgrade, many clusters).
- Skip-a-minor k3s jumps.
- Cross-cloud cluster migration.
- Tenant workload graceful drain during host-package upgrades. Worker reboots evict Pods; Longhorn/replicas handle continuity.
- Local/DinD upgrade path. Local stays "destroy and rebuild".
- Cross-cluster runtime staging-soak gate. Staging-soak is git-log-derived only.
- Per-migration `down()` functions (locked decision #5).
- Mode B staging cluster (Locked decision #12). Deferred to post-Phase-1.
- Release-cycle automation beyond manual `cut-release.sh` (locked decisions #2, #9).
- Drift-tracker workflow (skipped per operator preference).
- Vendored Helm chart wrapping bootstrap.sh.
- Demo cluster / hosted preview environment.

---

## 14. Upgrade Compatibility Model

Locked policy: **skip-multiple ALLOWED**. The operator on `installed_platform_version = 2026.04.1` can click "Upgrade to 2026.08.3" and the cluster jumps straight there, applying everything pending in version order during one upgrade run. No requirement to install intermediate versions one-by-one.

### What the operator sees

When pre-flight runs for a multi-version gap, the UI enumerates exactly what will happen:

```
Upgrading from 2026.04.1 → 2026.08.3

Pending platform-migrations (12):
  m0207  Add platform_baselines table
  m0208  Reseed host-config allow-list for fs.inotify
  ...
  m0218  Bump CNPG chart from 0.28.2 to 0.29.0

Pending host-migrations (3):
  2026-05-001  Create platform-ops group on every node
  2026-06-004  chattr +i /etc/platform/cosign.pub
  2026-07-002  Bump kernel.pid_max ceiling

k3s version: 1.30.2 → 1.32.1
  Will be split into 2 serial SUC Plans (Rancher policy refuses skip-a-minor):
    Plan A: 1.30.2 → 1.31.5 (drain one node at a time)
    Plan B: 1.31.5 → 1.32.1 (drain one node at a time)

⚠ BREAKING changes in the gap (must be acknowledged):
  ☐ 2026.05.2 — Stalwart RocksDB migration; requires 30min mail downtime
  ☐ 2026.07.1 — Tenant API contract change in /api/v1/tenants/:id/quota

[Confirm BREAKING acknowledgments above to enable Apply]
```

Auto-update behaves identically: a release whose CHANGELOG has `### BREAKING` (or any release in the gap to a non-BREAKING target has BREAKING in between) halts auto-application with the same UI surface.

### The mechanism

| Layer | Mechanism | Skip-multiple? |
|---|---|---|
| Platform image | Cluster jumps straight to target tag via Flux re-pin; intermediate images never installed | Yes (target image bundles all historic migrations) |
| Platform-migrations | Runner reads `platform_migrations` table, applies all unapplied entries in `(version, name)` order; advisory-locked | Yes |
| Host-migrations | Runner reads per-node `applied-host-migrations` ConfigMap, applies all unapplied scripts in version order | Yes |
| apt/dnf packages | Desired-state convergence; not version-sequential | Yes (trivially) |
| sysctls / kernel modules / ulimits | Desired-state convergence | Yes |
| k3s | SUC Plans serially; pre-flight refuses skip-a-minor and synthesises N hops if needed | **No** (Rancher policy; locked decision #8) |
| Kernel | apt/dnf-managed; distro handles ordering | Yes |
| `platform-ops` binary | Self-upgrade pulls target version directly | Yes |

### Migration-author constraints

Every platform-migration AND host-migration MUST be:

1. **Idempotent** — re-running on a node where it already applied is a no-op. Platform-migrations: use `IF NOT EXISTS` / `CREATE OR REPLACE` / guarded DDL. Host-migrations: marker files in `/var/lib/platform/host-migrations/<id>.applied`.
2. **Self-contained relative to ordering** — depends only on the state left by previously-numbered migrations. Bad: "assumes 2026.06.1 has been running for 5 minutes." Good: "assumes migration `m0207` has been applied (asserts `SELECT 1 FROM platform_migrations WHERE version='m0207'`)."
3. **Order-stable** — its position in the sequence is the contract. Renaming or renumbering a shipped migration is forbidden. CI guard refuses PRs that rewrite history.
4. **Self-validating where possible** — refuses to run if pre-conditions aren't met, with a clear operatorError. Allows the runner to halt cleanly and surface a real diagnostic.

Enforcement: `scripts/ci-migration-idempotency.sh` runs in PR CI. Parses every TS migration for forbidden patterns; shellchecks every host-migration; refuses renaming of any committed migration file.

### BREAKING in the gap — UX detail

When `installed=2026.04.1` and `target=2026.08.3`, pre-flight reads CHANGELOG sections for every release in the half-open range `(installed, target]`:

- For each section containing `### BREAKING`, surface as a separate acknowledgment row.
- Operator must check EVERY BREAKING checkbox before Apply enables.
- Auto-update (staging) halts if ANY BREAKING release sits in the gap. Bell-icon notification fires; operator must acknowledge from admin UI before auto-update resumes for that target.
- BREAKING release reached without acknowledgment = `UPGRADE_BREAKING_NOT_ACKNOWLEDGED` operatorError; run halts at pre-flight, no destructive step taken.

### What happens if a multi-version run fails partway

- Platform-migration N+1 fails: runner halts. `platform_migrations` table shows m0207...m0214 applied, m0215 marked `failed` with error_text. Operator-resumable from m0215 once the underlying issue is fixed.
- Host-migration on node X fails: runner halts on that node. Other nodes continue (each is independent). Per-node ConfigMap shows `2026-06-004` `failed`. Operator can resume per-node.
- k3s SUC Plan A succeeds, Plan B fails: cluster is on intermediate k3s version. Pre-flight on next attempt refuses skip-a-minor from the resumed state too. Operator either fixes Plan B's blocker or rolls back.
- Cluster has rescue snapshot from before the run started (locked decision #15). Worst case: full rollback.

### What this rules out

- **Downgrade**: not supported by this model. Platform-migrations are forward-only (`CLUSTER_UPGRADE_ROADMAP.md` locked decision #5). Downgrade = rollback to a snapshot.
- **Out-of-order migration**: forbidden by CI guard. The migration registry refuses to apply m0210 if m0207 is unapplied.
- **Renaming/renumbering shipped migrations**: forbidden by CI guard.
- **k3s skip-a-minor**: forbidden by Rancher policy; pre-flight catches.

---

## 15. Change Log

- 2026-05-23 — Initial holistic plan committed after multi-round planning session that folded versioning, release cycle, CI/CD docs, OSS readiness, OS-level convergence, DR, and operator CLI into one umbrella covering and amending `CLUSTER_UPGRADE_ROADMAP.md`.
- 2026-05-23 (revision) — Revised Decisions 17 + 18 from "Go binary + shared Go library" to "TypeScript binary (pkg/bun-compile) + direct module import". Triggered by parallel agent confirming orchestration logic lives canonically in TS modules (heavy work delegated to spawned Jobs); porting to Go would re-implement 4,000–8,000 LOC with perpetual maintenance overhead for mostly aesthetic gains. CLI moved to critical path (PR 9, was PR 9.5) so failure-mode/DR tooling exists from day-1 and parallel agent's snapshot primitives can be wrapped in PR 10. Controller+CLI pair PRs collapsed (W12/W13.5, W13/W11.5, W16/W16.5 each become single PRs since both surfaces import the same module). PR count: 22 → 20. Estimated calendar saving: ~3–4 weeks. Optional ~500-LOC Go wrapper for the self-upgrade + cosign-verify loop noted as deferred follow-up for static-binary purity on the security-critical bit.
- 2026-05-25 — Added Decision 21 (upgrade compatibility model: skip-multiple ALLOWED). Added new §14 with operator-experience walkthrough, mechanism table, migration-author constraints (idempotent + self-contained + order-stable), BREAKING-walks-the-gap UX, failure-mode behaviour, and what the model rules out. Updated W9 + W10c with migration-discipline notes and `scripts/ci-migration-idempotency.sh` CI guard. Renumbered Change Log §14 → §15.
