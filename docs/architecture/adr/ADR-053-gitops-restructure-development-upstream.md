# ADR-053: GitOps restructure — `development`-upstream branch + artifact-tracked staging/prod

**Status:** Accepted (2026-06-21)

Supersedes the `main → development` auto-merge model of [ADR-045](ADR-045-versioning-release-cycle-and-upgrade.md)
decisions 12 & 13. **No backward compatibility** — the two existing clusters (one
`staging`-role, one being stood up) are re-bootstrapped onto the new layout; no
other clusters exist.

## Context

The original flow (ADR-045 dec. 13) makes `development` a *downstream* mirror of
`main`: every push to `main` is auto-merged into `development` by
`sync-development.yml`, and the staging cluster's Flux tracks the `development`
branch. Tracing it (this session) surfaced six structural problems:

1. **Image pins live on `main`** — `build-deploy.yml` rewrites the overlay
   `newTag`s and pushes a `chore(development): pin …` commit to `main`, so the
   trunk carries the staging cluster's mutable deploy config.
2. **GITHUB_TOKEN can't trigger workflows**, so every image-CI workflow must be
   hand-listed in `sync-development.yml`'s `workflow_run:` block or its pin
   **strands on `main`** (a recurring footgun).
3. **`main` and `development` diverge permanently** — the `--no-ff` propagation
   merges mean fast-forward never works again (150+ "Merge main → development"
   commits accumulated).
4. **One branch, two hats** — `development` is both the *integration branch* and
   the *staging deploy source*; you cannot stage something without "integrating" it.
5. **No home for release candidates** — staging follows a *branch*, so an RC
   *tag* has nowhere to land (this is exactly where ADR-045 Mode B stalled).
6. **Overloaded names** — `--env staging` (cluster role) tracks the `development`
   branch; the rename itself is a symptom.

Production has **never cut over** (`k8s/overlays/production/kustomization.yaml`
`newTag: "0.0.0"`, "production cutover pending"), so the tag→image-pin path for a
tag-tracked cluster is **not actually wired** — `release.yml` builds
version-tagged images but edits no overlay, and a git tag is immutable after the
fact. This is a green-field opportunity, not a migration.

**Reusable machinery already exists:** `cut-release.sh [--prerelease]` (CalVer
`vYYYY.M.PATCH` / `-rc.N`), `release.yml` (fires on `v*.*.*` **including `-rc.N`**,
builds version-tagged + cosign-signed images + a signed `release-manifest.json`,
marks `prerelease` when the tag contains `-`), the cosign version-poller, the W13
`runUpgrade` re-pin (now `-rc`-aware, ADR-053-adjacent R22), and Flux
`GitRepository.spec.ref.semver`.

## Decision

A four-tier model: **`development` becomes the *upstream* integration branch**,
`main` is the promoted release trunk, and **staging/production track immutable,
signed release tags** instead of a branch.

### Branches

| Branch | Role |
|---|---|
| `development` | **Upstream** integration branch — in-progress / experimental work that is **not** yet meant for `main`. Feature branches and spikes land here. |
| `main` | Trunk / release source. Receives `development → main` via **reviewed PR** *after* the DEV cluster has exercised the change. No cluster deploys from `main` directly — it is "promoted, awaiting release." |

After each release, `development` is **rebased/merged from `main`** so it stays
close to released code (avoids re-introducing the old divergence — now any drift
is *meaningful* unreleased work, not merge-commit noise).

### Tags (cut **manually** from `main`)

- `scripts/cut-release.sh --prerelease` → `vYYYY.M.PATCH-rc.N` (release candidate)
- `scripts/cut-release.sh` → `vYYYY.M.PATCH` (stable)

RCs and stable releases are **always deliberate, manual cuts** — no auto-RC.

### Clusters

| Cluster | `--env` | Flux source | Update cadence |
|---|---|---|---|
| **DEV** | `dev` | `GitRepository.spec.ref.branch: development` | **auto** — every push to `development` (bleeding-edge, breakable) |
| **STAGING** | `staging` | `GitRepository.spec.ref.semver: ">=0.0.0-0"` | **auto** — picks the highest tag, **RC or stable** (`vX > vX-rc.2 > vX-rc.1 > v(X-1)`), so each manual cut rolls automatically |
| **PRODUCTION** | `production` | poller surfaces the latest **stable**; operator re-pins `spec.ref.tag` (W13) | **manual**, stable-only |

`>=0.0.0-0` is required for Flux's Masterminds/semver matcher to consider
prereleases at all; the highest match wins, so a stable supersedes its own RCs.

### Image / pin pipeline

- **Dev path:** push → `development` → `build-deploy.yml` builds the three images
  (timestamp tag), stamps `k8s/overlays/development` `newTag`s, and commits **to
  `development`**. Flux (DEV) deploys. An *intra-branch* pin — no cross-branch sync.
- **Release path:** `cut-release.sh` **stamps the `staging` + `production` overlay
  `newTag`s to the new version** (the B fix), then commits `VERSION` + `CHANGELOG`
  + overlays and creates the tag. `release.yml` (on the pushed tag) builds the
  `:version` images and cosign-signs the binary + manifest. The **immutable,
  signed tag fully describes its own image pins** — staging and production pull it
  verbatim. **`main` carries no deploy pins.**

### Concrete changes (implementation, post-ADR)

1. **Delete `.github/workflows/sync-development.yml`** — no more `main →
   development`; direction inverts to `development → main` via PR.
2. **`build-deploy.yml`** — trigger on push to **`development`** (not `main`); pin
   into `overlays/development` on `development`; drop the `HEAD:main` push, the
   reset-and-reapply retry, and the `workflow_run` propagation block.
3. **`cut-release.sh`** — add a pre-commit step (`kustomize edit set image` /
   `sed`) that sets `overlays/staging` + `overlays/production` `newTag`s to
   `$VERSION`, so the tag is self-describing. Stamp before the
   `VERSION`/`CHANGELOG` commit + tag.
4. **Overlays** — keep three, one per tier: `overlays/development` (DEV, branch),
   new `overlays/staging` (mirrors `production` + staging feature flags, e.g.
   `node-terminal-enabled` ON), `overlays/production` (prod). Drop the placeholder
   `newTag: "0.0.0"` once `cut-release` stamps them.
5. **Flux manifests** (`k8s/base/flux/`) —
   - `gitrepository-staging.yaml`: `ref.branch: development` → `ref.semver: ">=0.0.0-0"`.
   - DEV `GitRepository`: `ref.branch: development` (was `main`).
   - production: unchanged (tag + W13 re-pin).
6. **`bootstrap.sh`** — env→ref mapping: `dev` → branch `development` (was `main`);
   `staging` → `ref.semver` (was branch `development`); `production` → tag.
   Overlay dir: `dev` → `overlays/development`, `staging` → `overlays/staging`,
   `production` → `overlays/production`.
7. **`CLAUDE.md`** GitOps section + the version-poller/W13 docs updated to the new
   model **at implementation time** (not before — the clusters re-bootstrap first).
8. **New CI guard** (`ci-gitops-structure-check.sh`, suggested): assert no
   `GitRepository` tracks `main`, staging uses `ref.semver`, `cut-release.sh`
   stamps the staging+production overlays, and `sync-development.yml` is absent.

## Consequences

- Removes smells **①②③④⑤**; **⑥** improves (names finally map to real things:
  `development` is a branch *and* a DEV cluster; "staging" is the RC/stable channel).
- **Staging tests the exact signed artifact production will pull** — the parity gap
  that made ADR-045 Mode B awkward disappears.
- `development` is a genuine feature-integration branch with a throwaway DEV
  cluster — experiments can be tested live without touching `main`.
- `cut-release.sh` becomes the **single pin-stamper for releases** (self-describing
  tags); `build-deploy.yml` only stamps `development`. The trust model stays
  cosign-signed releases end to end (no registry-digest automation).
- The R22 `-rc`-aware W13 re-pin is now **unused by production** (staging gets RCs
  via Flux semver); it remains valid for the operator/canary path and is harmless
  (production keeps `auto_update_include_prereleases` OFF).
- **More tags** (every RC/stable is a manual cut) — intentional; cadence is the
  operator's.
- No rollback path is preserved (no backcompat) — correctness depends on the
  re-bootstrap landing the new `--env` mapping.

## Rejected alternatives

- **Auto-cut an RC on every `main` merge** (original Candidate 2): rejected —
  RCs/releases must be deliberate manual cuts.
- **Flux image-automation** (image-reflector + image-update-automation, Candidate
  1): its registry-**digest** trust model conflicts with the on-node
  cosign-**signed-release** model and adds two controllers; kept the signed-tag path.
- **Promotion pipeline + GitHub Environments** (Candidate 3): approval-gated
  promotion is governance overkill for a lean 1–2-operator OSS platform; revisit if
  the team / environment count grows.
- **Keeping `main → development` auto-merge**: it is the direct source of smells
  ②③ and the staging-can't-test-artifacts limitation.

## Rollout (re-bootstrap, no backcompat)

1. Land the code changes (workflows, `cut-release`, Flux manifests, `bootstrap`,
   overlays, CLAUDE.md) on `main`.
2. Recreate `development` fresh from `main` (drop the old merge history).
3. Re-bootstrap DEV: `bootstrap.sh --env dev` (tracks `development`).
4. Re-bootstrap STAGING: `bootstrap.sh --env staging` (tracks `ref.semver`).
5. `cut-release.sh --prerelease` → STAGING auto-follows the RC; verify; then
   `cut-release.sh` for stable.
6. Delete `sync-development.yml`.
7. Thereafter: rebase/merge `main` → `development` after each release (decision C).
