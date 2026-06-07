# Changelog

All notable changes to Insula are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning
is **CalVer `YYYY.M.PATCH`** (no leading-zero month — valid SemVer; [ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)).
Releases are cut ad-hoc with `scripts/cut-release.sh` (see [RELEASING.md](RELEASING.md)).

> A `### BREAKING` subsection in a release marks changes that break operators or
> APIs. Auto-update refuses to auto-apply any release whose section contains one
> until an operator acknowledges it.

## [Unreleased]

### Fixed
- **DKIM/DNS hygiene follow-ups** (2026-06-07 E2E findings): the email-domain
  enable flow no longer inserts a junk `._domainkey.<domain>` TXT record with
  an empty selector (M13-era stub); the disable flow now destroys the
  domain's Stalwart `DkimSignature` rows before destroying the principal
  (previously they orphaned in the registry); migration 0050 renames
  `dns_records."recordType"` → `record_type` to end the table's mixed
  column-naming (snake + camel) that broke hand-written SQL.

## [2026.6.6] - 2026-06-07

## [2026.6.5] - 2026-06-07

### Fixed
- **DKIM rotation actually works now + tenant domains are RSA-only.**
  Three fixes on top of the earlier RSA-keygen change: (1) the rotation
  route read the nonexistent `ENCRYPTION_KEY` env var (correct:
  `PLATFORM_ENCRYPTION_KEY`) and 500'd unconditionally; (2) rotation
  POSTed its Stalwart create to `/api/store/import`, which does not exist
  on v0.16.5 — it now uses JMAP `x:DkimSignature/set` (the wire
  stalwart-cli uses); (3) Stalwart auto-creates an Ed25519 signature next
  to the RSA one on every new domain principal — Gmail/M365 can't verify
  RFC 8463 signatures and Gmail reports dkim=fail in tenant DMARC
  aggregates — the enable flow now destroys the auto-created Ed25519 row
  (soft-fail; RSA-only policy, new `email-dkim/suppress-ed25519.ts`).

### Fixed
- **DKIM rotation now generates RSA-2048 keys** (was Ed25519). The rotation
  path was triply broken: Gmail/Microsoft 365 don't support RFC 8463
  ed25519-sha256 (Gmail reports dkim=fail instead of ignoring it), the
  rotated key's TXT record was published with `k=rsa` + SPKI encoding
  (invalid for Ed25519 even at verifiers that support it), and retiring the
  old RSA key per our own 14-day guidance left domains signing Ed25519-only
  — no verifiable DKIM at the largest providers. Rotation now uses the same
  RSA-2048 generator as initial provisioning, making the published DNS
  record correct and every rotated key Gmail-verifiable.

### Removed
- **Stalwart blob-store remnants fully deleted** (follow-up to the ADR-046
  fence): `mail-admin/blob-store.ts` + tests, api-contracts
  `mail-blob-store` schemas, and the orphaned `mail-blob-store` PvcRole.
  Findings live in ADR-046 + STALWART_BLOB_STORE_MIGRATION.md; code in git
  history.

### Added
- **Operator runbook `docs/operations/MAIL_STORE_SPACE_RECLAIM.md`** —
  reclaiming disk after bulk mail deletion (measured: zero reclaim after
  11.5h idle; purge→flush→compaction→blob-unref chain; offline `ldb
  compact` procedure; upstream blob-GC contribution note).

### Removed
- **Stalwart blob-store switch UI + routes fenced (ADR-046)** — the platform
  stays on Stalwart's Default (RocksDB) blob store. The admin-panel
  "Blob store" card (Email → Operations → Storage) and the
  `GET/PATCH /admin/mail/blob-store` + job-status routes were removed after a
  live E2E found the switch inoperative as shipped (config only applies on
  restart; schema-invalid S3 cli fields; self-verify false negatives; CIFS
  host mount never provisioned; Flux strips the runtime Deployment patch).
  The backend module + api-contracts schemas remain in-tree with STALE
  banners. fs→S3 / fs→CIFS blob migrations were proven byte-lossless, so the
  decision is reversible. See ADR-046 and the rewritten
  STALWART_BLOB_STORE_MIGRATION.md.

### Changed
- **Stalwart memory limit raised 512Mi → 1536Mi** (requests 128Mi → 256Mi).
  The 2026-06-05 20GB ingest stress test OOM-killed Stalwart at 512Mi
  (~2GB into a bulk IMAP import; loaded RSS runs 600–850MB at 15GiB of
  stored mail). At 1536Mi the same workload completed with zero restarts.

## [2026.6.4] - 2026-06-06

### Added
- **`make new-host-migration` scaffolder (Tier 3).** Generates a
  contract-complete W10c host-migration stub at
  `platform/host-migrations/<next-version>/<NNNN>-<name>.sh` (next version from
  `cut-release.sh --print-version`, next number auto-picked) — shebang,
  `set -euo pipefail`, both `# idempotent:` / `# allow-paths:` headers, and a
  body that fails loudly until implemented. Refuses to overwrite (order-stable).
- **Release-time host-migration audit in `cut-release.sh` (Tier 3).** The
  release plan now lists the host-migrations + `[no-host-migration]` waivers the
  release contains and re-checks the firewall shape across the whole delta since
  the previous tag; an uncovered shape change (changed, no migration, no waiver)
  **blocks the cut** (override `--allow-uncovered-host-changes`) — defence in
  depth behind the per-PR `ci-migration-coverage` guard.

### Changed
- **Firewall blacklist drop rule is now continuously converged (Tier 2).** The
  `firewall-reconciler` ensures the `@blacklist_v{4,6} drop` input-chain rules
  exist on every tick (netlink, distroless — no `nft` binary), so clusters
  bootstrapped before the blacklist feature self-heal with no one-shot
  migration, and the rule re-asserts after a reboot or out-of-band flush. The
  v2026.6.3 one-shot backfill migration is now redundant (kept; idempotent).

### Fixed
- **Internal images pinned to immutable tags (kill the `:latest` pull-race).**
  security-probe, firewall-reconciler, host-config-reconciler, backup-rclone,
  sftp-gateway and mail-backup-tools are now pinned to immutable
  `<timestamp>-<sha>` tags in the development overlay (rewritten by each image's
  own build workflow *after* the push, via `pin-image-tag.sh`), instead of
  `:latest` + a deploy-rev bump that raced the image push and could leave pods
  on a stale digest. Flux now only ever rolls to a tag that already exists.
- **Pin commits propagate to the development branch.** Added the six image-build
  workflows to `sync-development`'s `workflow_run` triggers — a pin commit is
  pushed with the workflow `GITHUB_TOKEN`, which does not fire the `push`
  trigger, so without this the pins stranded on `main`.
- **backup-rclone-shim is updatable when idle.** Its readiness is decoupled from
  `:9000` (launcher writes a liveness marker in both the idle and serving
  branches; probe is now `exec [ -f /var/run/backup-rclone/ready ]`). A
  target-less shim correctly idles without binding `:9000`, so the old
  `tcpSocket:9000` probe kept it NotReady and stalled a DaemonSet RollingUpdate
  (e.g. an image-pin bump) forever. It now reports Ready (alive) so rollouts
  complete, without serving a fake endpoint (no silent backup loss).

## [2026.6.3] - 2026-06-06

### Added
- **Operator firewall blacklist — permanent IP/CIDR bans.** A super_admin
  Network Trust → Blacklist tab (and a "Ban permanently" deep-link from the SSH
  Lockdown fail2ban modal) drops an IP or CIDR on ALL ports, on every node, via
  a new `ClusterFirewallBlacklist` CRD converged by the firewall-reconciler into
  nft `blacklist_v{4,6}` sets — permanent, complementing CrowdSec L4's automatic
  TTL'd bans. Two-layer self-lockout defense (backend + reconciler) refuses any
  ban that would catch a node IP / cluster peer / trusted range / the operator's
  own IP; type-to-confirm; audit-logged. The drop is placed after
  `ct state established,related accept` (an operator who bans their own IP keeps
  the live session) and before any port accept.
- **fail2ban SSH-ban visibility in the SSH Lockdown table.** The read-only
  security-probe now surfaces each node's persisted fail2ban bans (banned-now /
  24h / all-time counts + a per-IP modal: jail, banned-at, expiry, count) read
  from `/var/lib/fail2ban/fail2ban.sqlite3` (read-only, no control socket).
- **Host-migration: firewall-blacklist nft backfill (ADR-045 W10c).** A one-shot
  idempotent per-node migration backfills the blacklist nft sets + drop rules
  onto clusters bootstrapped before the feature (fresh installs get them from
  bootstrap). Applied surgically (never `nft -f`, which would flush the whole
  ruleset and break CNI), persisted for reboot, self-healing on partial failure.
- **CI migration-coverage forcing function (Tier 1).** `ci-migration-coverage.sh`
  fails any PR that changes bootstrap.sh's firewall shape without shipping a
  host-migration backfill (or an explicit `[no-host-migration]` waiver) — so the
  "fresh-render reaches new installs but not existing nodes" gap can't recur
  silently.
- **WAL-archive health monitor + alerting + auto-disable circuit-breaker**
  (`backend/src/modules/wal-archive-health/`; follow-up to the plugin-presence
  fix). Covers the case the presence fix doesn't: a SYSTEM backup target IS
  configured but its sink is unreachable, so CNPG's `wal-archive` fails every
  segment and pg_wal climbs toward a full volume. A 5-min scheduler reads the
  CNPG `ContinuousArchiving` condition + pg_wal pressure (`pg_ls_waldir()`; the
  app role is a `pg_monitor` member) and: (1) **alerts** via the notifications
  subsystem — new admin categories `admin.wal_archive_failing` (error) and
  `admin.wal_archive_auto_disabled` (critical, mandatory); (2) as a last-resort
  **circuit-breaker**, if archiving keeps failing AND pg_wal crosses 75 % of the
  data volume, **auto-disables archiving** (removes the barman plugin →
  `wal-archive` no-op-succeeds → WAL recycles) so the volume can never fill even
  if the alerts go unseen for days. The disable is persisted in
  `platform_settings` and ENFORCED by the `postgres-objectstore` reconciler
  (overriding UI-WAL-streaming ownership); `enableWalArchive`/`enableWalStreaming`
  refuse while tripped. Operators clear it via `POST /admin/wal-archive-health/
  reset-breaker` (super_admin) after fixing the target. The 75 % threshold is the
  sustained-failure guard (it takes many hours of failure to reach it — a brief
  sidecar restart doesn't). E2E-proven on staging.

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
- **`platform-ops dr` disaster-recovery subcommands** ([ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)
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
- **`platform-ops` operator CLI** ([ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)
  W17): a self-contained Node SEA binary (`scripts/build-platform-ops.sh`) that
  imports the backend TS modules directly — no logic duplication. First tranche
  of read-only subcommands: `version` (offline-first; enriches from the DB when
  reachable), `cluster status`, `cluster diagnostics`, `migrations list` (stub
  until the registry ships), and `shell`. `release.yml` builds amd64 + arm64,
  cosign-signs them (offline, key-based), and attaches them as Release assets;
  bootstrap installs + verifies them (see W8). Covered by Vitest unit tests +
  `scripts/test-build-platform-ops.sh` (real build + sign→verify→install
  roundtrip, CI job `platform-ops binary build`).
- **Bootstrap phase library + platform-ops install** ([ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)
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
- **Version spine** ([ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)):
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
