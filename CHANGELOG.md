# Changelog

All notable changes to Insula are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning
is **CalVer `YYYY.M.PATCH`** (no leading-zero month — valid SemVer; [ADR-045](docs/07-reference/ADR-045-versioning-release-cycle-and-upgrade.md)).
Releases are cut ad-hoc with `scripts/cut-release.sh` (see [RELEASING.md](RELEASING.md)).

> A `### BREAKING` subsection in a release marks changes that break operators or
> APIs. Auto-update refuses to auto-apply any release whose section contains one
> until an operator acknowledges it.

## [Unreleased]

### Fixed
- **CRITICAL: a targetless CNPG cluster no longer self-destructs by filling its
  volume with un-recyclable WAL.** A freshly-bootstrapped cluster with no backup
  target shipped `archive_mode=on` pointed at the backup-rclone-shim S3 sink,
  which doesn't start until a target is configured — so every WAL archive failed,
  Postgres couldn't recycle WAL, `archive_timeout=5min` pumped ~192 MB/h, and
  pg_wal filled the 10 GiB `system-db` volume in ~2 days → CNPG halted Postgres →
  cluster failure (observed: 17 MB DB, 9.6 GB pg_wal, `pg_stat_archiver`
  archived=0 / failed=6841). Root cause: the platform controlled
  `spec.plugins[].isWALArchiver`, but CNPG keeps `archive_mode=on` for as long as
  the barman-cloud plugin ENTRY is *present* — independent of `isWALArchiver`. The
  `postgres-objectstore` reconciler now manages the plugin entry's PRESENCE (adds
  it when a SYSTEM target is bound, after materializing its ObjectStore; removes
  it otherwise), and `k8s/base/database.yaml` no longer ships a static entry. A
  fresh cluster starts with no barman plugin: with no archiver attached, CNPG's
  `wal-archive` command no-op-succeeds (archive_mode itself stays on — CNPG owns
  that GUC) so Postgres recycles WAL instead of failing against the dead sink.
  CI guard `ci-backup-rclone-shim-check.sh` Invariant 10 now *rejects* a static
  plugin entry. When a SYSTEM target IS bound the plugin is present + real
  archiving and scheduled base backups run exactly as before (the UI WAL-streaming
  path in `system-backup/wal-archive.ts` is unchanged). **Operator note:** deploying
  this to an EXISTING cluster triggers a CNPG-managed rolling Postgres restart (the
  plugin reconcile); a target-bound cluster ends with the plugin present (archiving
  continues), a targetless one with it absent — ~5–15 s single-instance, a
  switchover on HA. Verified on staging: removing the plugin drained pg_wal
  9.6 GB → 641 MB, cluster healthy 3/3, archive failures stopped.

### Added
- **`platform-ops dr` disaster-recovery subcommands** ([ADR-045](docs/07-reference/ADR-045-versioning-release-cycle-and-upgrade.md)
  W17, PR 10): `dr verify` (read-only: age-decrypt + print a bundle's manifest —
  no DB, no cluster, runs on a bare jump host) and `dr restore` (`--mode partial`
  imports backup-config rows read-only; `--mode full` runs CNPG recovery + mail
  restore). The host binary wraps the backend `dr-restore` `runDrRestore`
  primitive DIRECTLY — the same module `scripts/dr-restore-bundle.sh` drives —
  so it works when platform-api is down. `--mode full` keeps the per-cluster
  type-to-confirm (`--confirm-cluster <name>`, value === cluster name) + a
  required `--target-mail-node`. Failure output emits a stable error label only
  on stdout `--json` (never the error body, which can carry the age key path or
  a DSN); the full diagnostic goes to stderr with credentials scrubbed. Covered
  by 29 Vitest cases (`dr.test.ts`).

### Changed
- **platform-ops signature verification is now openssl-only on nodes** (no cosign
  on hosts). A cosign `sign-blob --key` signature is plain base64-encoded
  ECDSA-P256/SHA256, which `openssl dgst -verify` validates against the pinned
  public key — so nodes need no 120 MB cosign binary; cosign is a CI-only
  (signing) tool. Replaces the prior node-side `cosign verify-blob
  --insecure-ignore-tlog` approach. `openssl` is now explicit in the bootstrap
  package lists (it was already a transitive dependency).

## [2026.6.2] - 2026-06-01

### Added
- **`platform-ops` operator CLI** ([ADR-045](docs/07-reference/ADR-045-versioning-release-cycle-and-upgrade.md)
  W17): a self-contained Node SEA binary (`scripts/build-platform-ops.sh`) that
  imports the backend TS modules directly — no logic duplication. First tranche
  of read-only subcommands: `version` (offline-first; enriches from the DB when
  reachable), `cluster status`, `cluster diagnostics`, `migrations list` (stub
  until the registry ships), and `shell`. `release.yml` builds amd64 + arm64,
  cosign-signs them (offline, key-based), and attaches them as Release assets;
  bootstrap installs + verifies them (see W8). Covered by Vitest unit tests +
  `scripts/test-build-platform-ops.sh` (real build + sign→verify→install
  roundtrip, CI job `platform-ops binary build`).
- **Bootstrap phase library + platform-ops install** ([ADR-045](docs/07-reference/ADR-045-versioning-release-cycle-and-upgrade.md)
  W8): `scripts/lib/bootstrap-phases.sh` now owns a `phase_platform_ops` step
  that bootstrap.sh runs at end-of-run on the first server — it cosign-verifies
  and atomically installs the `platform-ops` operator CLI to `/usr/local/bin`,
  persists the trust anchor to `/etc/platform/cosign.pub`, and lays down a daily
  `platform-ops-update.timer`. Best-effort + fail-closed (an unverified binary is
  never installed); a dormant no-op until the release pipeline publishes a signed
  binary. Covered by `scripts/test-platform-ops-install.sh` (CI `shell-unit-tests`).

### Changed
- `bootstrap.sh` now sources `scripts/lib/bootstrap-phases.sh`; the legacy
  single-file `curl | bash` install one-liner is no longer supported (clone the
  repo or use `--remote`, both of which already carry `scripts/lib/`).
- `platform/cosign.pub` is committed as the trust anchor for `platform-ops`
  release verification (see [RELEASING.md](RELEASING.md) to provision the key).

### Fixed
- `phase_platform_ops` (W8) verify now passes `--insecure-ignore-tlog` so
  key-based verification works **offline** (releases are signed without a Rekor
  log entry; the pinned public key is the trust anchor) — without it the
  cluster-down install path failed "signature not found in transparency log".
- `phase_platform_ops` no longer uses a `RETURN` trap for temp cleanup (it
  leaked past the function and re-fired on the caller's return with out-of-scope
  vars under `set -u`); cleanup is now explicit at each return.

## [2026.6.1] - 2026-06-01

### Added
- **Version spine** ([ADR-045](docs/07-reference/ADR-045-versioning-release-cycle-and-upgrade.md)):
  `platform/VERSION` (CalVer) is the single source of truth, flowing through CI →
  the `platform-version` ConfigMap → backend → DB → `GET /api/v1/admin/platform/version`,
  which now returns `{ installed, running, available }`. The backend persists
  `installed_platform_version` on startup.
- **Release cycle**: `scripts/cut-release.sh` (CalVer computation, CHANGELOG
  promotion, annotated tagging), this `CHANGELOG.md`, and `RELEASING.md`.
- **OSS readiness**: AGPL-3.0 `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`,
  issue/PR templates, a rewritten top-level `README.md`, and per-component READMEs.
- **Image-org fork-safety**: image-building workflows derive their push org from
  `${{ github.repository }}`; `scripts/preflight-image-org.sh` repoints the
  kustomize tree for fork deploys; CI guard `scripts/ci-image-org-check.sh`.

### Changed
- `build-deploy.yml` computes the development build version from `platform/VERSION`
  (was `git describe`), so the deployed version is CalVer (`2026.6.1-<sha>`).
- `release.yml` no longer opens a PR to a `stable` branch; production Flux pins a
  tag directly. Release notes now come from the matching `CHANGELOG.md` section.
