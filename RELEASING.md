# Releasing Insula

Releases are **ad-hoc** ([ADR-045](docs/07-reference/ADR-045-versioning-release-cycle-and-upgrade.md)
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

It does **not** push. Review, then:

```bash
git push && git push origin v<version>
```

## What the tag fires

`.github/workflows/release.yml` (on `v*.*.*`):
1. **validates** the tag matches `platform/VERSION` (refuses a mismatched tag);
2. builds + pushes the three images tagged `<version>`;
3. creates a GitHub Release whose notes are the matching `CHANGELOG.md` section
   (prereleases — tags containing `-` — are marked accordingly).

### Production deployment (transitional)

This release **no longer opens a PR to a `stable` branch** — that automation is
gone. The replacement (production Flux pinning a `spec.ref.tag`, re-pinned by the
in-cluster version-poller on operator click) is a **later workstream** and not
yet implemented. The residual `stable`-branch Flux config (`gitrepository-stable.yaml`,
`kustomization-production.yaml`, and `bootstrap.sh`'s production path) is retired
together with that work.

Until then there is no automated production rollout. Production is **not yet
provisioned**, so nothing is broken today; when it is, deploy a release by
pinning the production overlay to the release tag manually (or via the
version-poller once it lands).

## Versioning rules

- `YYYY.M.PATCH`, no leading-zero month (e.g. `2026.6.1`, **not** `2026.06.1`).
- Pre-releases: `-rc.N` only.
- **Never compare versions as raw strings** — use semver-aware comparison
  (`sort -V` / the `semver` library); leading-zero-free CalVer is valid SemVer.
