# Releasing Insula

Releases are **ad-hoc** ([ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)
Decision 2) — cut one when accumulated changes warrant it, not on a fixed
schedule. Versioning is **CalVer `YYYY.M.PATCH`** (no leading-zero month, so it
stays valid SemVer). The next version is derived from existing git tags, not a
stored counter.

## Before you cut

1. Make sure everything you want to ship is on `main` and green.
2. Curate the `## [Unreleased]` section of [CHANGELOG.md](CHANGELOG.md): it
   becomes the release notes verbatim. Use `### Added/Changed/Fixed/Removed`.
   If the release breaks operators or APIs, add a `### BREAKING` subsection
   describing the break and any migration steps.

## Cut the release

```bash
git switch main && git pull
scripts/cut-release.sh                 # patch bump for the current month
scripts/cut-release.sh --prerelease    # YYYY.M.PATCH-rc.N
scripts/cut-release.sh --breaking      # required if [Unreleased] has ### BREAKING
scripts/cut-release.sh --dry-run       # preview, no changes
```

`cut-release.sh`:
- computes the next version (`2026.6.1` → `2026.6.2`; a new month → `.1`);
- promotes `[Unreleased]` → `[<version>] - <date>` and leaves a fresh `[Unreleased]`;
- writes `platform/VERSION`;
- creates a commit `chore(release): v<version>` and an **annotated** tag `v<version>`.

!!! note "The CHANGELOG promotion happens on `main` only"
    `cut-release` runs from `main` (ADR-053), so it promotes the CHANGELOG on the
    trunk. `development` is **auto-reconciled** after the release publishes (see
    [What the tag fires](#what-the-tag-fires), step 5) — you do **not** hand-edit
    `development`'s CHANGELOG. Historically this drift was fixed by hand every cut;
    the release pipeline now does it.

It does **not** push. Review, then:

```bash
git push && git push origin v<version>
```

## What the tag fires

`.github/workflows/release.yml` (on `v*.*.*`):
1. **validates** the tag matches `platform/VERSION` (refuses a mismatched tag);
2. builds + pushes the three images tagged `<version>`;
3. builds the `platform-ops` operator CLI as a self-contained Node SEA binary
   for amd64 + arm64 (`scripts/build-platform-ops.sh`), **cosign-signs** each
   (key-based, offline — `--tlog-upload=false`), and attaches the binaries +
   `.sig` files as Release assets that bootstrap fetches and verifies;
4. creates a GitHub Release whose notes are the matching `CHANGELOG.md` section
   (prereleases — tags containing `-` — are marked accordingly);
5. **syncs `development`'s CHANGELOG** (stable tags only) via
   `scripts/sync-development-changelog.sh`: it rebuilds `development`'s CHANGELOG
   from the tag (authoritative released history) and scopes `[Unreleased]` to
   only the bullets NOT in the new `[<version>]` section — i.e. work added after
   the cut. Idempotent; commits `[skip ci]` and pushes with rebase-retry.
   (Unit-tested: `scripts/test-sync-development-changelog.sh`.)

## platform-ops signing key (one-time operator setup)

The `platform-ops` binary is installed on every node by bootstrap and later
self-upgrades daily as root, so it is **cosign-verified** before it is ever
placed on PATH (fail-closed — see `scripts/lib/bootstrap-phases.sh`). Signing is
**key-based + offline**: the in-repo `platform/cosign.pub` is the trust anchor;
the private key signs releases in CI.

Until the signing secret is set, releases ship the binaries **unsigned**, and
bootstrap's auto-install stays **dormant** (it refuses to install an unverified
binary — no security regression). Signing uses a **password-less** key, so there
is exactly **one** secret to manage:

```bash
COSIGN_PASSWORD="" cosign generate-key-pair    # password-less (cosign.key + cosign.pub)
cp cosign.pub platform/cosign.pub              # commit the new trust anchor
gh secret set COSIGN_PRIVATE_KEY < cosign.key  # the ONLY secret needed
```

No `COSIGN_PASSWORD` secret is required: `release.yml` passes an empty password,
which matches the password-less key (`cosign sign-blob --key env://COSIGN_PRIVATE_KEY`).
Setting it via the web UI instead: **repo → Settings → Secrets and variables →
Actions → New repository secret**, name `COSIGN_PRIVATE_KEY`, value = the full
contents of `cosign.key` (including the `-----BEGIN/END-----` lines).

> **Key handling:** keep `cosign.key` out of the repo (it is not gitignored by
> name — never `git add` it). The committed `platform/cosign.pub` that ships
> today was generated during W17 bring-up; **rotate to an operator-generated key
> before hardened production** (regenerate, re-commit the `.pub`, re-set the
> secret). Rotating only affects *future* releases — already-installed binaries
> keep verifying against whatever `/etc/platform/cosign.pub` they were installed
> with until the next upgrade.

### Production deployment — the admin-controlled pull model

A release does **not** open a PR to a `stable` branch (that automation is gone,
ADR-045 Dec. 10). Production runs the **pull model**, which is built and wired:

1. **Detect.** The `version-poller` CronJob (`k8s/base/version-poller-cronjob.yaml`)
   runs hourly on every cluster, fetches the repo's GitHub Releases, **cosign-
   verifies** the signed `release-manifest.json` against the baked-in
   `platform/cosign.pub`, and writes the newest verified stable tag to
   `platform_settings.available_version` (fail-closed — an unverifiable release
   is never surfaced).
2. **Review.** The admin panel's **Updates** page (`/platform/updates`) shows the
   available version and runs read-only pre-flight gates.
3. **Apply (operator click).** `POST /api/v1/admin/platform/upgrade`
   (super_admin) captures a rescue snapshot, then **re-pins the production Flux
   `GitRepository.spec.ref.tag`** to the release tag (`platform-upgrades/flux-repin.ts`).
   Flux rolls every Deployment (incl. platform-api) to the new tag; a post-flight
   observer verifies convergence and recommends rollback if it stalls.
   Equivalent host-side path: `insula cluster upgrade --version vX.Y.Z --apply`.
4. **Rollback.** `POST /api/v1/admin/platform/rollback` restores the previous
   ref (optionally with a data restore).

The production Flux source is a **tag-pinned** `GitRepository`
(`k8s/base/flux/gitrepository-production.yaml` + `kustomization-production.yaml`),
created by `bootstrap.sh --env production --release-tag vX.Y.Z` (it refuses a
tag that has not been cut). There is **no branch merge, suspend/unsuspend, or
`stable` branch** — the operator's Apply click is the gate.

> Scope note: the **apply/re-pin path** is unit-tested but its end-to-end
> exercise against a live cluster is `scripts/integration-platform-upgrade.sh`
> (added 2026-07-28). Dev follows a branch and staging follows Flux-native
> `ref.semver`, so neither exercises the operator-click re-pin in normal
> operation — run that integration script against a disposable cluster before
> trusting an upgrade on a real production cluster. Production is **not yet
> provisioned**, so nothing is at risk today.

## Versioning rules

- `YYYY.M.PATCH`, no leading-zero month (e.g. `2026.6.1`, **not** `2026.06.1`).
- Pre-releases: `-rc.N` only.
- **Never compare versions as raw strings** — use semver-aware comparison
  (`sort -V` / the `semver` library); leading-zero-free CalVer is valid SemVer.
