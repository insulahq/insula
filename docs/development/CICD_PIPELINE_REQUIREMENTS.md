# CI/CD Pipeline — As-Built

> **Status:** describes the pipeline **as it actually runs today** (rewritten
> for the version-spine + pull-model architecture, [ADR-045](../architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)).
> Supersedes the prior weeks-1-12 / MariaDB / Harbor / stable-branch spec.

## 1. Principles

1. **Pull, never push.** CI builds images and commits git pins. It **never
   mutates a live cluster** — clusters converge themselves (Flux reconciles git;
   the version-poller applies releases on operator click). Enforced by
   `scripts/ci-no-cluster-push.sh` (a workflow that runs a write-verb
   `kubectl`/`helm`/`flux` against a cluster fails the build).
2. **One version artefact.** `platform/VERSION` (CalVer `YYYY.M.PATCH`) is the
   single source of truth; everything else is a transform of, or check against,
   it (see §4).
3. **Fork-safe.** Image org is derived from `${{ github.repository }}`, so a fork
   publishes to its own GHCR with no edits ([FORK-AND-DEPLOY.md](FORK-AND-DEPLOY.md)).
4. **GitOps.** Flux v2 is the only thing that applies manifests to a cluster.

## 2. Branches (3-branch GitOps)

| Branch | Role |
|--------|------|
| `main` | Development trunk. CI builds images on merge. The staging/test clusters track the **`development`** branch, which receives `main` via `sync-development.yml`. |
| `development` | Formerly named `staging` (W1 / ADR-045 Decision 13 — the CLUSTER role keeps the name "staging"; the branch is `development`). Receives `main` via `sync-development.yml` (`git merge --no-ff`, so it keeps its own merge history — not a byte-mirror), carrying the auto-pinned image tags + `platform-version`. The **staging and testing clusters' Flux** watch this branch. Not a manual promotion gate. |
| ~~`stable`~~ | **Dropped** ([ADR-045](../architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md) Decision 10). Production no longer tracks a branch; it pins a release **tag** (the in-cluster version-poller re-pins on operator click — a later workstream). |

Release tags `vYYYY.M.PATCH` carry production release semantics; see §6.

## 3. Workflow inventory

20 workflows under `.github/workflows/`.

**Per-component test CI** (lint + typecheck + unit/integration tests, **no image
push**):
- `ci-backend.yml` — lint, typecheck, and `npm run test:coverage` (Vitest unit +
  integration) against a `postgres:18-alpine` service
  (`DATABASE_URL=postgres://platform:platform@…/platform_test`).
  *(A `redis:7-alpine` service is still declared; the platform moved to an
  in-memory cache at M14, so it is vestigial and a candidate for removal.)*
- `ci-admin-panel.yml`, `ci-tenant-panel.yml` — lint, typecheck, Vitest, build.
- `ci-api-contracts.yml` — builds the shared Zod/TS contracts.

**Per-component image CI** (build + Trivy scan + push to GHCR; one image each):
`ci-file-manager`, `ci-sftp-gateway`, `ci-firewall-reconciler`, `ci-security-probe`,
`ci-backup-rclone`, `ci-tenant-backup-tools`, `ci-node-terminal-image`,
`ci-private-worker-agent`, `ci-rocksdb-secondary-checkpoint`, `ci-claim-validator`.
Each uses `IMAGE: ghcr.io/${{ github.repository }}/<name>` and pushes only on
non-PR events (fork PRs build + scan but never push).

**Platform image + deploy:**
- `build-deploy.yml` — on `main` push (paths-filtered), builds **backend +
  admin-panel + tenant-panel**, computes the version from `platform/VERSION`
  (`<version>-<sha>`), pins the development overlay (`apply-development-pin.sh`), and
  commits `chore(development): pin platform-version to <version>` to `main`.
- `sync-development.yml` — merges `main` → the `development` branch (`--no-ff`).

**Release:**
- `release.yml` — on `v*.*.*` tag: validates the tag matches `platform/VERSION`,
  builds + pushes the 3 images `:<version>`, and creates a GitHub Release whose
  notes are the matching `CHANGELOG.md` section. **No stable-branch PR.**

**Guards + housekeeping:**
- `ci-infrastructure.yml` — kustomize build, shellcheck, the **`shell-unit-tests`**
  job (runs `scripts/test-*.sh` harnesses), the **`no-cluster-push`** guard, and
  ~30 invariant guards (`scripts/ci-*.sh`: firewall, admin-auth gate, image-org
  fork-safety, system-tenant, mail-arch, backup-shim, …).
- `ci-pin-lag-check.yml` — verifies the development pin isn't orphaned behind the
  last code commit.

> **No DR drill in public CI.** The disaster-recovery rehearsal runs **locally or
> on a private host** via `scripts/dr-drill.sh`, never in GitHub Actions — its
> inputs (the operator's age private key + a super_admin report token) are far too
> sensitive to store as public-repo Actions secrets. See
> [DR_DRILL.md](../operations/DR_DRILL.md).

## 4. The version spine

```
platform/VERSION (e.g. 2026.6.1)
   │  build-deploy.yml: VERSION = <file>-<sha>
   ▼
platform-version ConfigMap (in cluster, via Flux)
   │  PLATFORM_VERSION env on platform-api
   ▼
backend persists platform_settings.installed_platform_version on startup
   ▼
GET /api/v1/admin/platform/version → { installed, running, available }
```

`cut-release.sh` is the only thing that edits `platform/VERSION`; between
releases it stays at the last released tag while CI computes `<version>-<sha>`
for the development build. Details: [ADR-045](../architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md).

## 5. Deploy flow (development / staging / testing)

1. PR merged to `main` → green CI required (component tests + infra guards).
2. `build-deploy.yml` + the relevant sidecar `ci-*.yml` build the changed
   images and push to `ghcr.io/insulahq/insula/*`.
3. `build-deploy.yml` pins the development overlay — `apply-development-pin.sh`
   sed-rewrites the image `newTag`s (the `$imagepolicy` comments in the overlay
   are vestigial; there are no Flux `ImagePolicy` resources) and writes the
   `platform-version` ConfigMap — then commits to `main`.
4. `sync-development.yml` merges `main` → `development` (`--no-ff`).
5. The staging + testing clusters' **Flux** (watching `development`) reconcile —
   pull the new images + ConfigMap, roll the Deployments. **CI does not touch
   the cluster.**

Local dev is separate and does **not** use this pipeline: `./scripts/local.sh up`
builds images locally and imports them into an in-Docker k3s (no GHCR pull, no
MariaDB/Redis containers).

## 6. Release flow (production-bound)

1. Curate `CHANGELOG.md` `## [Unreleased]` (add a `### BREAKING` subsection if
   the release breaks operators/APIs).
2. `scripts/cut-release.sh` computes the next CalVer, promotes the CHANGELOG,
   writes `platform/VERSION`, and creates an annotated tag (`RELEASING.md`).
3. Push the tag → `release.yml` validates `tag == platform/VERSION`, builds +
   pushes `:<version>` images, and publishes a GitHub Release from the CHANGELOG
   section. Prereleases are `-rc.N`.
4. **Production deploy:** there is no stable branch. A production install
   (`bootstrap.sh --env production`) pins its Flux GitRepository to a release
   **tag** — `v<platform/VERSION>` of the bootstrapping checkout, or
   `--release-tag vYYYY.M.PATCH` (the tag must exist on the remote;
   bootstrap fails fast otherwise). From then on the in-cluster
   version-poller (W11) surfaces newer signed releases and the upgrade flow
   (W13/W14) re-pins the tag on operator approval. Production is not yet
   provisioned.

## 7. Container registry & fork-safety

- Registry: **GHCR**, org derived from `${{ github.repository }}`.
- Canonical: `ghcr.io/insulahq/insula/*`. A fork's CI publishes to its own org.
- Static manifests (`k8s/`) hardcode the canonical org; a fork repoints them with
  `scripts/preflight-image-org.sh`. CI guard: `scripts/ci-image-org-check.sh`.

## 8. Secrets & permissions

- Image-build + release workflows use only `secrets.GITHUB_TOKEN` (GHCR push via
  `packages: write`; Releases via `contents: write`). **No long-lived cluster
  credentials, age keys, or report tokens live in public CI.** The DR drill — the
  one job that would need them — was deliberately moved out of GitHub Actions to a
  local/private runner (`scripts/dr-drill.sh`, [DR_DRILL.md](../operations/DR_DRILL.md))
  precisely so those secrets never sit in a public repo.
- No `pull_request_target` triggers — fork PRs run with a read-only token and no
  secret access; image-push steps are gated on non-PR events.
- In-cluster secrets are Sealed Secrets (GitOps) / age-encrypted bundles
  ([SECRETS_LIFECYCLE.md](../operations/SECRETS_LIFECYCLE.md)) — never in CI.

## 9. Rollback

Because nothing is force-pushed to a cluster, rollback is git/snapshot-based, not
a CI action:
- **Development/staging:** revert the offending commit on `main`; the pin +
  `sync-development` carry it to `development`; Flux reconciles.
- **A bad image tag:** re-pin the previous `<version>-<sha>` (revert the
  `chore(development): pin …` commit).
- **Cluster/data-level:** Longhorn snapshot restore + the upgrade rollback path
  (later workstream, W16) — not a pipeline step.

## 10. CI guards (regression invariants)

Guards under `scripts/ci-*.sh`, wired into `ci-infrastructure.yml`, encode rules
that must not regress. New invariants ship with a guard **and** a
`scripts/test-*.sh` harness (run by the `shell-unit-tests` job). Notable:
`ci-no-cluster-push.sh` (§1), `ci-image-org-check.sh` (§7),
`ci-firewall-check.sh`, `ci-admin-auth-check.sh`, `ci-system-tenant-check.sh`,
`ci-migration-idempotency.sh` (planned, W9).
