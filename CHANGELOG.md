# Changelog

All notable changes to Insula are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning
is **CalVer `YYYY.M.PATCH`** (no leading-zero month — valid SemVer; [ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)).
Releases are cut ad-hoc with `scripts/cut-release.sh` (see [RELEASING.md](RELEASING.md)).

> A `### BREAKING` subsection in a release marks changes that break operators or
> APIs. Auto-update refuses to auto-apply any release whose section contains one
> until an operator acknowledges it.

## [Unreleased]

## [2026.6.17-rc.1] - 2026-06-23

### Added
- **Production ships both webmail engines (Bulwark + Roundcube).** The webmail-router
  reconciler runs whichever engine `default_webmail_engine` selects and scales the other to
  0, so only one webmail pod ever runs. Previously the production overlay shipped only
  Roundcube, so a fresh cluster whose default engine is `bulwark` 404'd on `webmail.<apex>`
  (the reconciler had no Deployment to scale). Staging inherits this via `../production`.

### Fixed
- **Tenant hard-delete now reaps stranded Longhorn volume CRs and deletes the DB row last.**
  `applyDeleted` dropped the tenant row immediately after requesting the namespace delete,
  while the namespace was still terminating and its Longhorn volume CR still detaching — and
  the by-PV-name `pv-cleanup-released` hook can't reap a volume CR that outlives its PV. A
  new scoped, bounded post-delete reap (`reap-namespace-volumes.ts`) clears this tenant's
  Released PVs + stranded Longhorn volume CRs by namespace before the row is deleted.
  Proven live on the DEV cluster (reaped the orphaned volume CR a prior session had to
  delete by hand).
- **Dev-cluster oauth2-proxy no longer wedges `Init:0/1`.** On `--env dev` the base init did
  strict-TLS OIDC discovery over the public Dex issuer, which never readied (http issuer
  404s; an LE-prod cert may not issue on a dev domain). The development overlay now does
  token-redeem + JWKS over the cluster-internal Dex Service (plaintext `:5556`, skip
  discovery), and `bootstrap.sh` bakes an https issuer + redirect for `--env dev` to match
  Dex's advertised issuer and registered client.
- **Integration test timing is adaptive on multi-node clusters.** Firewall-reconciler
  convergence (`FW_RECONCILE_WAIT`, 60→150s), trusted-proxies ConfigMap+DaemonSet
  (`TP_RECONCILE_WAIT`, 30s@1s→90s plus an explicit DaemonSet-args poll), break-glass
  IngressRoute (15→45s), and the cross-node smoke probe (6s/1-retry → 15s/2-retry) no
  longer false-fail on the 4-node staging cluster. Loops exit early on success, so the wider
  budgets are free on the happy path.

### Changed
- **Valkey removed from the deployed path** (resource savings): nothing consumes it in the
  automated config (the backend cache is in-memory LRU; Stalwart wiring is manual-only). The
  `valkey/` entry is commented out of the development overlay — the base manifests, overlay
  wrapper, and `migrate-valkey-bootstrap.sh` are kept so re-activation is a one-line
  uncomment. The `scenario_redis` integration test skips by default while disabled.

## [2026.6.16] - 2026-06-22

### Added
- **In-cluster Dex restored on staging for OIDC integration testing.** ADR-053 made the
  staging overlay a pure mirror of production, which (correctly) has no in-cluster Dex —
  but that also removed the ability to test the OIDC flow on staging. Dex is now a
  staging-only delta (`k8s/overlays/staging/dex/`); production still ships no Dex
  (`ci-no-dex-in-production.sh` stays green). Side effect: un-sticks the base oauth2-proxy
  on staging, whose `wait-for-dex-discovery` init was blocking on the pruned issuer.

### Changed
- **Admin node-terminal is now ENABLED in production** (`overlays/production`). It's a
  break-glass tool operators need and is HA-safe with no extra config: the single-use
  `wsToken` is validated against the Postgres `node_terminal_sessions` table (any
  platform-api replica serves any session — the old in-memory design that required
  single-replica/stickiness is obsolete), and base already sets the platform-api Service
  `sessionAffinity: ClientIP`. Still gated by the 30-min OIDC step-up + 256-bit single-use
  60s wsToken.

### Fixed
- **bootstrap: Stalwart auth probe now retries a transient `000`** instead of refusing to
  bootstrap (exit 1). The mail pod can be momentarily unreachable (host-port
  rolling-update gap / admin listener lagging the rollout-ready signal); retries up to
  10×6s before giving up.
- **smoke-test.sh no longer lets `../.env.local` clobber caller-provided creds.** A local
  `.env.local` was overriding the `ADMIN_PASSWORD`/`API_URL`/`ADMIN_EMAIL` exported for a
  REMOTE cluster, 401'ing the smoke gate with local-dev creds. The caller's env now wins.

## [2026.6.15] - 2026-06-22

### Added
- **k3s multi-minor auto-step (R21, ADR-045 dec. 21).** `platform-ops cluster upgrade --version <target>`
  now splits a multi-minor jump into serial single-minor hops automatically — it resolves each
  intermediate minor's latest patch from the k3s release channel, applies the SUC Plans, and waits
  for every node to reach that minor before the next hop (the final hop rolls async). Single-minor /
  patch upgrades are unchanged. The per-hop generator still refuses skip-a-minor as the safety net.
- **Release-candidate Flux re-pin (R22, ADR-045 dec. 12 — Mode B).** The platform upgrade re-pin now
  accepts a `-rc.N` tag, gated by `auto_update_include_prereleases` (default ON staging / OFF prod).
  A staging cluster with the flag on re-pins Flux from the `development` branch to the newest
  release-candidate tag (the poller already selects RCs); production refuses an `-rc.N` tag even via
  an explicit `--version <rc>`. Apply stays operator-gated (no auto-apply loop added).
- **Tenant provision-on-activate model.** `POST /tenants` now creates a tenant `pending` +
  unprovisioned (no auto-provision); provisioning is explicit (admin "Provision Now" or
  `POST /admin/tenants/:id/provision`) and flips the tenant to `active` on completion. Non-active
  tenants are blocked from deploying workloads, configuring domains/ingress, and setting up email
  domains/mailboxes with a clear `TENANT_NOT_ACTIVE` (409). Fixes tenants stuck `pending` forever and
  the downstream `452 4.3.1 mail system full` their mailboxes hit. Admin UI: "Provision Now" in the
  create-success dialog + a not-provisioned warning banner on the tenant detail page.

### Fixed
- **ADR-053 cutover: bootstrap applied the wrong overlay for `--env staging`.** The stale
  `staging → development` overlay remap applied the development overlay's 20Gi system-db patch while
  Flux reconciled the 2Gi staging (production-mirror) overlay → CNPG rejected the storage shrink →
  the platform Kustomization deadlocked `Ready=False`. bootstrap now mirrors `install_flux`'s
  env→overlay mapping exactly (dev→`development`, staging→`staging`, production→`production`).
- **Multi-node HA mail was unreachable on the non-active server nodes.** The `stalwart-mail` Service
  used `externalTrafficPolicy: Local`, so kube-proxy dropped externalIP mail traffic
  (:25/:465/:587/:993) on every node without a local Stalwart endpoint — i.e. exactly the HAProxy
  nodes the externalIPs land on. Changed to `Cluster`; the HAProxy DaemonSet's send-proxy-v2 still
  re-injects the real client IP, so SPF/DKIM source IP is preserved. (Surfaced by the ADR-053
  production-mirror staging; the development overlay had masked it by stripping the field.)
- **Per-tenant file-manager was broken on every non-dev cluster (ImagePullBackOff).** The production
  `platform-config` overlay was missing the `file-manager-image` override, so the base ConfigMap's
  bare `file-manager:latest` resolved to `docker.io/library/file-manager:latest` (does not exist).
  Added the GHCR override to the production overlay (the dev overlay already had it). Surfaced by the
  ADR-053 production-mirror staging.

### Security
- **Upgraded k3s v1.33.10 → v1.35.5+k3s1** (Kubernetes stable channel) to cut base-OS CVEs in the
  kube image stack. Rolled minor-by-minor (1.33 → 1.34.8 → 1.35.5) via system-upgrade-controller on
  the staging HA cluster; smoke 35/0, all nodes Ready, CoreDNS healthy after each minor.
  > **Upgrading existing clusters:** k3s is SEQUENTIAL — step ONE minor at a time
  > (`platform-ops cluster upgrade --version <next-minor> --apply`, validating between). The plan
  > generator and auto-update both refuse skip-a-minor; do not jump multiple minors in one step.

## [2026.6.14] - 2026-06-20

### Security
- **Roundcube webmail rearchitected to fpm-alpine + nginx sidecar (0 CVE).** The
  official apache image is Debian-based (700+ HIGH/CRITICAL base-OS CVEs even at
  1.6.16); replaced with the fpm-alpine image (0/0) served by an nginx:1.30-alpine
  sidecar (also 0/0). Verified on testing: serves end-to-end (login page, PHP,
  Postgres session, POST, branding, deny rules) and scales up/down correctly with
  the `default_webmail_engine` setting via the webmail-router reconciler.
- **Refreshed upstream images to cut base-OS CVEs** (~1650 → ~350 across the
  fleet): roundcube, alpine/k8s 1.33.3/.4→1.33.13, modsecurity-crs date-build,
  frps v0.62.1→v0.69.1, curl 8.10.1→8.20.0, oauth2-proxy v7.15.3, valkey 8.1-alpine.
  Each scanned to confirm the reduction; deployed + smoke-tested (35/0) on testing.
- **Upgraded Calico v3.31.5 → v3.31.6** (CNI patch). Deployed + verified on the
  staging cluster (rolling calico-node upgrade, all nodes Ready throughout, DNS +
  cross-node pod connectivity + ingress all healthy).
- **Upgraded Traefik chart 40.2.0 → 41.0.0** (app v3.7.1 → v3.7.5). The chart-major
  breaking changes are only the `logs.*`/`accessLog.*` value-key renames, which our
  install doesn't set — verified by upgrading with our user-supplied values only
  (not `--reuse-values`, which carried chart-40 defaults the new schema rejects).
  Deployed + verified on staging: DaemonSet rolled 4/4, modsecurity + crowdsec
  plugins reloaded, ingress 200, WAF blocks a SQLi probe (403).
- **Upgraded sealed-secrets chart 2.17.4 → 2.18.6** (controller 0.31.0 → 0.37.0).
  Deployed + verified on staging: controller 1/1 on 0.37.0, the sealing key
  persisted and was re-registered on startup (existing SealedSecrets stay
  decryptable), HTTP server serving, no errors.

### Changed
- **image-cve-scan is report-only while the base-OS-CVE backlog burns down**
  (`REPORT_ONLY=true`): unwaived HIGH/CRITICAL warn but don't fail the run; a
  scan-infrastructure failure still fails hard. Flip to enforcing once cleared.

## [2026.6.13] - 2026-06-20

### Added
- **Upstream-image Trivy CVE scan in CI (ADR-050).** New weekly + on-demand
  `.github/workflows/image-cve-scan.yml` Trivy-scans the upstream images we deploy
  (Stalwart, Postgres, CrowdSec, …) for OS/library CVEs the version+advisory watch
  can't see — entirely in CI, no cluster resources. Pinned + checksum-verified
  trivy binary; skips findings already tracked in `security/cve-ledger.yaml`; fails
  the run on a new untracked HIGH/CRITICAL. Closes the gap that left the Stalwart
  image's Debian base-OS CVEs (e.g. openssl heap-UAF, perl-archive-tar path
  traversal) unscanned. Helpers: `scripts/list-scan-images.sh`,
  `scripts/cve-ledger-trivyignore.py`, `scripts/trivy-scan-summary.py` (unit-tested).
- **`component-watch.sh --changelog <id>`** — surfaces the upstream release notes
  between a component's pinned version and latest, flagging breaking/migration
  notes, with open-issues + compare links. Required before bumping a tier-0 pin.

### Changed
- **Component-watch weekly sweep now leads with a ⚠️ Tier-0 (critical) components
  behind upstream callout** so critical drift (e.g. the Stalwart mail server, which
  had quietly fallen four releases behind) surfaces immediately instead of being
  buried in the rolling tracking issue.

### Security
- **Upgraded the Stalwart mail server v0.16.5 → v0.16.9** (was 4 releases behind).
  Cuts the image's HIGH/CRITICAL CVE count from 26 → 15; the remaining 15 are
  Debian base-image CVEs (perl-base, libsqlite3, curl, libssh2, ncurses) with no
  fix in the latest upstream release, all outside the mail daemon's runtime path
  (Rust binary on the RocksDB store) — triaged `not_affected` in
  `security/cve-ledger.yaml`. Verified on testing: RocksDB store intact, all
  SMTP/Submission/IMAP/IMAPS/JMAP listeners serving, 0 restarts.

## [2026.6.12] - 2026-06-19

### Added
- **Lockout-prevention bridge on Security → Posture → Firewall Posture.** When
  your current connection's source IP isn't in any trusted range, the tab warns
  (locking down SSH / enabling L4 enforce would lock you out) and offers a
  one-click "add my IP" to the cluster trusted ranges. The IP is derived
  server-side from the Traefik-set X-Real-IP (never the request body),
  host-scoped (/32 or /128), super_admin-gated.
- **Bulk-apply NetworkPolicy hardening templates to tenant namespaces** (Security
  → Posture → Network Policies). Three egress-restricting templates —
  *isolate-tenant*, *deny-all-egress*, *allow-dns-only* — that compose on top of
  the ingress-only tenant baseline. Dry-run preview shows the exact affected
  namespaces before a type-to-confirm apply; one managed policy per namespace
  (`insula-hardening-egress`), reversible via Remove. Auto-skips the SYSTEM
  tenant, opt-out namespaces (`insula.host/netpol-hardening=optout`), and any
  namespace with a custom egress policy. Calico enforcement live-proven. Runbook:
  [SECURITY_HARDENING.md](docs/operations/SECURITY_HARDENING.md#networkpolicy-hardening-templates-network-policies-tab).
- **Restore a tenant from a retained Longhorn volume.** A destructive shrink (or
  archive) leaves the old volume detached + `Released` with its snapshots intact
  (`longhorn-tenant` is `reclaimPolicy: Retain`). The admin tenant-detail page now
  has a **"Restore from a retained volume"** card that lists those volumes + their
  snapshots and rolls the tenant back onto a chosen one (quiesce → Longhorn
  `snapshotRevert` → rebind PVC by `volumeName`, raising the storage quota if
  needed). The volume in use is kept as a `Released` fallback — reversible. This
  is the recovery path for the `SNAPSHOT_VOLUME_MISMATCH` case the in-place revert
  refuses. The orphaned-volumes reaper now skips a `Released` volume that still
  holds a restorable snapshot, so a fresh retained fallback is never auto-purged.
  Runbook: [TENANT_SNAPSHOTS.md](docs/operations/TENANT_SNAPSHOTS.md).
- **Offline etcd restore now works for every shim upstream protocol — S3,
  SFTP, and CIFS/SMB** (it was S3-only). `restore-etcd-from-shim.sh --offline`
  renders a private per-run `rclone.conf` for the descriptor's `storageType`;
  SFTP/SMB passwords are rclone-obscured and all credentials live in the 0600
  conf, never on the command line. Proven against real Hetzner S3 / SFTP /
  CIFS, including a destructive cluster-down recovery over CIFS.

### Fixed
- **Force-cancelling a storage op no longer leaves the tenant's workloads scaled
  to 0.** `quiesce` now persists the pre-quiesce replica snapshot *before*
  scaling anything down (capture → persist → apply), so `…/storage/cancel` (or a
  crash) mid-op always has the data to bring every workload back to its prior
  replica count — previously a cancel that raced the post-quiesce persist found
  the tenant DOWN with no record of its replica counts (manual `kubectl scale`
  recovery). All quiesce-based ops (resize/shrink, restore, retained-restore,
  suspend, archive, fsck) benefit; fsck now persists a snapshot it didn't before.
- **Destructive PVC shrink no longer hangs at "Scaling workloads to zero" on a
  single node.** Three layered bugs: (1) the `@kubernetes/client-node`
  serializer silently dropped `replicas: 0`, so quiesce's scale-to-0 was a no-op
  (now done via a raw merge-patch to the `/scale` subresource); (2) the
  file-manager auto-restarted within ~2s and fought quiesce (quiesce now stamps
  an `insula.host/storage-quiesced` annotation that blocks the auto-start until
  the op finishes); (3) a pod stuck `Terminating` on a slow Longhorn unmount kept
  the PVC's RWO lock (now force-deleted past a grace window). Shrink — and every
  quiesce-based op (in-place / retained restore, fsck) — now succeeds first-try.
- **The off-site etcd restore (`restore-etcd-from-shim.sh`, both online and
  offline) called a nonexistent `k3s etcd-snapshot restore` subcommand** and
  would have failed *after* downloading the snapshot — the worst time, mid
  disaster. k3s has no such subcommand; restore is a server-reset op, so it now
  runs `k3s server --cluster-reset --cluster-reset-restore-path=<snapshot>`
  (matching the local Tier-0 path). Operator docs that referenced the
  nonexistent command are corrected.
- **The secrets-bundle export silently omitted `dr-system-target.json`** — the
  descriptor the OFFLINE etcd restore reads — unless `PLATFORM_ENCRYPTION_KEY`
  happened to be on `app.config`. It now falls back to `process.env`, so the
  bundle always carries the descriptor when a SYSTEM target is bound.
- **`platform-ops dr preflight`** only recognised S3 `endpoint =` lines when
  checking that the off-site target is external, so it falsely warned on an
  SFTP/SMB (`host =`) upstream. It now matches both.

### Changed
- **platform-ops' embedded break-glass scripts are single-sourced from one
  manifest** (`backend/src/cli/platform-ops/embedded-scripts.ts`): the CLI
  dispatch (typed), the binary build, and a new CI guard
  (`ci-platform-ops-embed-check.sh`) all derive from it, so the signed binary,
  the CLI, and the on-disk scripts cannot drift apart. Internal — no
  operator-facing change.

## [2026.6.11] - 2026-06-16

### Added
- **Disaster-recovery break-glass: tiered etcd restore that works when the
  cluster is DOWN (R20 follow-up).** The off-site etcd restore used to need
  `kubectl` (to read the shim ClusterIP + creds) — but in a real etcd disaster
  the kube-API is down, so the one restore you need most couldn't run. Now there
  are three tiers, tried in order:
  - **Tier 0** `restore-etcd-local.sh` (+ `platform-ops dr restore-component etcd
    --local`) — restore from this node's local k3s snapshots; no network, no
    kubectl, no shim. The first thing to try when the disk survived.
  - **Tier 1** `restore-etcd-from-shim.sh --offline --bundle <secrets-*.tar.age>
    --age-key <key>` — pulls the off-site snapshot DIRECTLY from the real
    upstream S3, with no kubectl. It reads the decrypted `system` target from a
    new `dr-system-target.json` carried inside the age-encrypted secrets bundle
    (emitted by `/admin/system-backup/export-secrets-bundle` when a SYSTEM target
    is bound). S3 upstreams; the credential travels via env, never argv.
  - **Tier 1b** the existing kubectl→shim path (cluster up), unchanged.
  - **`platform-ops dr preflight`** reports, per tier, whether each restore would
    actually work — run it ahead of a disaster. Runbook:
    [BACKUP_RCLONE_SHIM.md](docs/operations/BACKUP_RCLONE_SHIM.md#recover-etcd--tiered-break-glass).
- **Per-file / per-folder restore from tenant backup bundles (#105).** The files
  component is now captured as a restic tree, so the restore cart can browse a
  bundle (`GET …/tenant-bundles/:id/browse/files/tree?path=` — lazy, one
  directory per call; admin + tenant) and restore a selection via a `files-paths`
  cart item (`{ kind: 'paths', paths: […] }`, up to 10 000 paths) instead of the
  whole archive. Restore is a restic-native overlay (`restic restore --include …`
  → `cp -a`, idempotent overwrite, no delete) with a pre-restore snapshot taken
  for rollback. Documented in [TENANT_BACKUP.md](docs/operations/TENANT_BACKUP.md).
- **platform-ops CLI E2E coverage in the staging suite.** Extended
  `integration-platform-ops-cli-e2e.sh` to assert the read-only / idempotent R18
  surface (`version`, `cluster doctor`, `backup key-status`, `backup target list`
  + idempotent re-bind) and wired it into `integration-staging.sh` as a
  `platform_ops` scenario (the destructive domain-rename leg stays opt-in).
- **Operator runbooks** for three shipped subsystems:
  [PLESK_MIGRATION.md](docs/operations/PLESK_MIGRATION.md) (R1),
  [TENANT_SNAPSHOTS.md](docs/operations/TENANT_SNAPSHOTS.md) (R19), and
  [PLATFORM_DOMAIN_RENAME.md](docs/operations/PLATFORM_DOMAIN_RENAME.md) (R16);
  roadmap + changelog reconciled to match what's actually shipped.

### Changed
- **The `mail-backup-tools` image is renamed `tenant-backup-tools`** — it now
  backs tenant-bundle files/mailboxes, the Plesk mail/discovery legs, and restic
  file restore. Override env vars are unchanged (`PLESK_MAIL_TOOLS_IMAGE`,
  `PLESK_DISCOVERY_IMAGE`, the tenant-bundle tools-image vars).

## [2026.6.10] - 2026-06-15

### Added
- **`platform-ops` operator-CLI additions (R18 consolidation).**
  - `cluster doctor` — per-node readiness/drift check (platform-ops version,
    cosign trust anchor, host-config kubeconfig, cluster reachability, rclone,
    host-migration markers, nodes-ready). Exit 1 on any FAIL; `--json`.
  - `backup target list|add|test|delete|bind|unbind` — manage backup targets +
    class bindings from a node (runs in the platform-api pod), removing the need
    to mint an admin JWT and hand-craft REST calls. `add` takes the config JSON
    on stdin (secret never in argv); list strips credentials.
  - `backup key-status` — show the BACKUP_TARGET_KEY fingerprint + rotation
    times (read-only companion to `backup rotate-key`).
  - `mail rotate-master-password` — rotate the Stalwart webmail master password
    (recovery; runs the same JMAP rotation the admin panel does, rolls Roundcube).
  - `cluster diagnostics` now includes the on-node nft firewall posture.
- **Worker nodes can now run host-config (host-migrations / package converge).**
  Worker hosts have no k3s admin kubeconfig (`/etc/rancher/k3s/k3s.yaml` is
  server-only), so `platform-ops host-config` was a permanent "cluster
  unreachable" no-op there — host-migrations (e.g. the rclone backfill) never ran
  on workers. A new `host-config-reader` ServiceAccount (RBAC: `get` on exactly
  the 5 desired-state ConfigMaps, name-scoped, no list/write) plus a tiny
  workers-only `host-config-kubeconfig` DaemonSet writes a least-privilege
  kubeconfig to `/etc/platform/host-config/kubeconfig` on each worker host (the
  DaemonSet has zero network, drops ALL caps, and can only write that subdir —
  never the cosign trust anchor at `/etc/platform/cosign.pub`). The converger now
  falls back to that kubeconfig after the k3s admin one. New CI guard pins the
  least-privilege contract (`ci-host-config-check.sh`). Security-reviewed: no
  critical/high; documented hardening follow-ups — an expected-apiserver anchor
  to validate the kubeconfig `server` (defense-in-depth vs a compromised writer
  pod) and `bootstrap.sh` ensuring `/etc/platform/host-config` is a real dir
  (anti-symlink). The busybox writer image is digest-pinned.

## [2026.6.9] - 2026-06-15

> First production cut since 2026.6.8 (2026-06-09). It captures the accumulated
> development-branch work from 2026-06-11 → 06-14 (continuously deployed to the
> dev cluster) in addition to the 06-15 host-dependency changes below.

### Added
- **Plesk migration service (R1, ADR-052, PRs #70–#89).** A new agentless
  `plesk-migration` module: source registry + SSH discovery (keyfile *or*
  password; discovery fails visibly with a classified reason), provision a
  discovered subscription onto a new or existing sized tenant (capacity
  preflight), and per-leg import of databases (per-tenant MariaDB via a dedicated
  `migration-tools` image), website content (rsync onto `apache-php`, PVC sized
  to the real docroot), mailboxes (IMAP MULTIAPPEND, `new/`→`cur/` reshape
  preserves unread state), cron jobs, and primary-DNS zones. E2E-proven on
  staging against a real Plesk Obsidian source.
- **FBL complaint processing (R4, PRs #64–#69).** Feedback-loop ingestion via
  Stalwart webhooks + `x:ArfExternalReport` — an `fbl@<apex>` SYSTEM mailbox + a
  JMAP poller writing `email_fbl_complaints`, per-domain complaint-rate
  thresholds, and notify/auto enforcement (one-click or automatic throttle +
  outbound-mail suspension), surfaced in Monitoring → Mail. Runbook
  [MAIL_FBL.md](docs/operations/MAIL_FBL.md).
- **Rolling sending-quota enforcement (R6, PRs #64–#69).** Per-tenant plan-based
  hourly/daily send limits via the Stalwart JMAP registry
  (`x:MtaOutboundThrottle` + `x:MtaQueueQuota`, applied with `ReloadSettings`),
  rolling per-hour send accounting (`email_send_counters` fed by send webhooks),
  80/100 % usage notifications + UI, and a Sending-Protection control
  (off / notify / auto). Replaced the dead static `[queue.throttle]` TOML.
- **Monitoring SLO completion (R2, ADR-051, PRs #50–#63).** In-API SLO alert
  evaluator + admin SLOs tab, SLO alerts routed through the categorised
  notification sources, admin-host path routes for VMUI (`/metrics/`) + the
  Longhorn UI (`/longhorn/`) with an HA-replicated metrics volume, and a
  `platform_flux_unready_resources` readiness gauge replacing a Flux-failure rule
  that could never fire.
- **Per-plan maximum mailbox size.** Hosting plans carry `max_mailbox_size_mb`
  (+ per-tenant override); new mailboxes default to it and over-max creation is
  refused (`MAILBOX_QUOTA_EXCEEDS_LIMIT`). Plan codes/names aligned
  (Starter/Premium/Ultimate).
- **Tenant on-server volume snapshots (R19, PRs #90–#102).** A `tenant-panel`
  Snapshots page (list / create / delete via Longhorn CSI) with a 48 h reaper +
  admin expiry, plus **full-volume restore via in-place Longhorn
  `snapshotRevert`** (shared `storage-lifecycle/longhorn-revert.ts`).
- **Turnkey platform-apex rename (R16, 2026-06-13/14).** `platform_domain` split
  from `ingress_base_domain` (migration 0066) + `getPlatformApex()`, and a `POST
  /admin/platform-domain/rename` action + rename UI under which the admin/panel
  IngressRoutes, LE certs, Stalwart web-admin, and the private-worker tunnel
  anchor all follow the new apex (seed-then-disown); the tenant CNAME target is
  unaffected.
- **`platform-ops` operator-CLI — first tranches (R18 T1–T4).** `admin
  reset-password`, `domain rename` (both in-pod — the native-dep graph isn't
  SEA-safe), `dr restore-component <etcd|mail|postgres>` (embedded bash), and the
  T3 housekeeping subcommands (`cluster gc-namespaces|upgrade-cnpg`,
  `component-watch`, `node-terminal gc`, `backup rotate-key`). See 2026.6.10 for
  the R18-finish convenience batch.
- **`rclone` is now a host dependency on every node.** The DR restore scripts
  (`restore-{etcd,mail,postgres}-from-shim.sh`, `platform-ops dr
  restore-component`) run rclone on the host to pull a snapshot from the
  backup-rclone-shim S3 endpoint before a local restore — but it was never
  installed (only the backup *upload* path, which runs in a pod, had rclone).
  Fresh installs get it via `bootstrap.sh` (`install_packages_{apt,dnf}` +
  `install_rclone_if_missing` static fallback for AL2023); existing nodes get it
  via host-migration `2026.6.9/0001-install-rclone.sh` (run because
  host-migrations now default to `enforce` — see Changed). Pinned static
  fallback tracks the shim's rclone line (1.74.1).

### Changed
- **Host-migrations now run by default (`enforce`), no longer opt-in
  (`observe`).** `host-migrations-desired` previously shipped `mode: observe`
  (report-only) so the host-config runner was a strict no-op until an operator
  opted in. Platform-migration `0008` flips it to `enforce` on every cluster
  (new clusters right after the seed; existing clusters on upgrade), so shipped
  host-migration scripts apply automatically (e.g. the rclone backfill above).
  This is safe to default-on: the scripts are platform-authored, CI-validated
  (idempotent + allow-paths-bounded), and embedded in the cosign-signed
  `platform-ops` binary. An operator who wants report-only sets `mode: observe`
  after the upgrade — `0008` runs once and won't re-flip it. The
  operator-content gating policies (`host-packages-/ulimits-/modules-desired`,
  which carry operator-supplied names) stay `observe`.
- **`python3` is now an explicit `bootstrap.sh` dependency and is auto-installed
  if missing.** It was always required (CIDR/IP validation, node-IP pinning,
  admin/backup JSON bodies) but only assumed present; a minimal base image
  failed `--allow-source` validation before `install_packages` ran. Added to
  `install_packages_{apt,dnf}` plus an `ensure_python3` early-bootstrap helper.
- **Backups are namespaced by a stable `cluster_id`** (cross-cluster restore
  safety). A generate-once `cluster_id` UUID (in `platform_settings`, not the
  apex) prefixes the system/postgres, mail-restic, and etcd-snapshot backup paths
  so two clusters sharing one bucket+prefix can't `--latest`-restore each other's
  state. The static postgres ObjectStore + the etcd-snap CronJob are held with
  `reconcile: disabled` (seed-then-disown) so the reconciler's `cluster_id` path
  sticks against Flux. Tenant backups stay cluster-agnostic (migration-ready).

### Fixed
- **Per-mailbox Stalwart quota was never applied.** The JMAP patch used
  `quota/storage` (an invalid patch in Stalwart 0.16) instead of
  `quotas/maxDiskQuota` (bytes) — quotas never reached Stalwart on create *or*
  update. Now set at creation; verified via `x:Account`.
- **Destructive PVC shrink — five-bug chain (PRs #90–#95).** Quiesce now waits
  only on pods mounting the target PVC (a stuck cert-manager solver no longer
  times it out) and actually scales workloads to 0 (the scale-subresource was a
  no-op); the pre-resize capture writes a files-only restic bundle through a
  per-class S3 streaming store (the hostPath store was PodSecurity-blocked under
  baseline PSA); tenant namespaces are labelled so the snapshot/backup Jobs can
  reach the rclone shim; and the failed-op banner clears when the lifecycle rolls
  back to idle.
- **etcd off-box backup silently no-op'd (DR gap).** The etcd-snap CronJob ran on
  a read-only rootfs with no writable `/tmp`, so every off-box upload wrote
  nothing (0 copies). Added an `emptyDir` at `/tmp`; the etcd break-glass restore
  also now resolves the rclone-shim ClusterIP instead of `.svc` DNS (unresolvable
  from a bare node).
- **`/backups/restore` cart crash + Tenant-Backups list 500.** The shared restore
  cart pulled in a second copy of React in the panel image (`Cannot read null` in
  `useState`) — fixed with Vite `resolve.dedupe`. Separately, the admin
  Tenant-Backups list 500'd because `db.execute()` (node-postgres) returns
  `{rows}`, not a bare array, and an `openCart` query referenced a stale enum.

## [2026.6.8] - 2026-06-09

## [2026.6.7] - 2026-06-07

### Changed
- **DKIM selectors are now a fixed alternating pair — `dkim-1` / `dkim-2`**
  ([ADR-047](docs/architecture/adr/ADR-047-dkim-ab-selectors.md), the Microsoft 365
  `selector1`/`selector2` pattern, replacing per-rotation timestamped
  selectors). Rotation flips signing to the other selector with a fresh
  RSA-2048 key; the previous selector's key + TXT record stay live, so mail
  in receivers' retry queues keeps verifying and **no retirement step exists
  anymore** (the rotate response no longer returns `recommendedRetireOldAt`;
  it now returns `previousSelector` + `destroyedSelectors`). Tenants on
  external DNS configure two TXT records once and never touch DNS on
  rotation. Enable + drift-repair now replace Stalwart's auto-created
  `v1-rsa-<date>`/`v1-ed25519-<date>` signature pair with one platform
  RSA-2048 signature under `dkim-1` and publish its TXT record inline
  (previously first published by the next dns-sync cycle). Migration 0051
  adds `email_domains.dkim_active_selector`; existing domains converge onto
  the pair at their first rotation or re-enable.

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
  sftp-gateway and tenant-backup-tools are now pinned to immutable
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
