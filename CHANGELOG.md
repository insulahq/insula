# Changelog

All notable changes to Insula are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning
is **CalVer `YYYY.M.PATCH`** (no leading-zero month — valid SemVer; [ADR-045](docs/architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)).
Releases are cut ad-hoc with `scripts/cut-release.sh` (see [RELEASING.md](RELEASING.md)).

> A `### BREAKING` subsection in a release marks changes that break operators or
> APIs. Auto-update refuses to auto-apply any release whose section contains one
> until an operator acknowledges it.

## [Unreleased]

## [2026.7.1-rc.23] - 2026-07-15

### Fixed
- **Staging now follows RC host-migrations.** `platform-ops self-upgrade` picks
  its target from the `platform-version` ConfigMap, but the base ships
  `version: "unknown"` and only the development overlay patched it — so
  production and staging both ran with `"unknown"`. That failed `isValidVersion`,
  and the fallback is GitHub `/releases/latest`, an endpoint that **excludes
  prereleases**. Staging therefore targeted the newest STABLE while Flux had an
  RC applied, so an RC's host-migrations were **never exercised on the cluster
  whose entire job is validating RCs** (observed 2026-07-15: staging ran
  platform-ops rc.20 / 2026.6.18 with rc.21 deployed). `cut-release.sh` now
  stamps the release version into a production-overlay `platform-version` patch,
  which staging inherits — so each cluster's platform-ops targets the version it
  is actually running, no update-channel concept needed. Production benefits
  too: its platform-ops now matches the admin-pinned release instead of jumping
  to the newest stable, which is what the admin-controlled pull model intends.
  Side effect: the admin panel no longer reports the platform version as
  "unknown" on staging/production.

### BREAKING
- **Tenant SFTP is reachable for the first time — new host, new port, FTPS
  removed.** Tenant file upload never worked on any real deployment: the
  gateway Service was `type: LoadBalancer`, but bootstrap runs k3s with
  `--disable=servicelb` and self-managed VPS nodes have no cloud LB, so it sat
  at `EXTERNAL-IP <pending>` forever and **nothing ever bound the port**. It is
  now a **hostPort DaemonSet on every control-plane server**, mirroring the
  `stalwart-haproxy` mail DaemonSet — the platform's pattern for raw TCP.
  - **Connect to `files.<apex>:23022`** (was: an unreachable `sftp.<apex>:2222`
    — and before that the connection-info API literally advertised the local
    dev hostname `sftp.k8s-platform.test`, because the `sftp_gateway_host`
    setting it read was never written by anything). The port stays overridable
    via `sftp_gateway_port`. 23022 is constrained: a hostPort must stay outside
    30000-32767 (NodePort range) and below 32768 (the ephemeral range, where it
    can collide with outbound source ports).
  - **Operators must add DNS:** `files.<apex>` CNAME → `<apex>`, whose A records
    already point at the control-plane servers, so it round-robins across
    exactly the nodes running the DaemonSet. `files.<apex>` is now a reserved
    platform hostname (ADR-040) and can no longer be claimed by a tenant.
  - **Firewall:** fresh installs get the `23022/tcp` accept from `bootstrap.sh`;
    existing clusters are backfilled by host-migration
    `2026.7.1/0002-sftp-gateway-firewall-port.sh` (ADR-045 W10c).
    `firewall-reconciler` cannot do this — it only opens hostPorts for tenant
    namespaces (`client-*`), not `platform-system`.
  - **FTPS is REMOVED** (`ftps_port` and the `ftps` instruction are gone from
    the connection-info API). It never actually ran — its TLS Secret is
    `optional: true` and nothing ever created it, so the listener self-disabled
    on every deployment while the API still advertised FTPS to tenants. It also
    cannot be exposed sanely: passive mode needs a 100-port range (whose old
    `30000-30099` default collided with the NodePort range) plus a per-node
    public IP a DaemonSet cannot supply, and active mode is unusable behind NAT
    — doubly so with TLS hiding `PORT` from `nf_conntrack_ftp`. SFTP/SCP/rsync
    over the same gateway cover the use case with stronger auth.

### Added
- **Tenant add-on databases: two-layer backup + visible dump summary**
  (ADR-048 Primitive 3 evolution). Every add-on database (MariaDB/MySQL,
  PostgreSQL, MongoDB, SQLite) is now captured two ways in a bundle: the
  **raw-files floor** (the `files` restic snapshot always includes each
  engine's on-disk datadir, which crash-recovers to committed-consistent —
  so a bundle is never without a recoverable copy) **plus** a best-effort
  **logical dump** on top for portable / cross-version restore. SQL dumps run
  `mysqldump`/`mariadb-dump --single-transaction --quick --routines
  --triggers` (**hot-consistent, no table lock, no write-downtime**);
  **MongoDB is now covered** via `mongodump --archive --gzip` (was silently
  unsupported). A **free-space guard** skips the logical dump when the DB
  pod's volume is >= 90% full or < 200 MiB free, so a dump can never `ENOSPC`
  the live database. Per-database outcome is recorded in a new
  `backup_jobs.database_dumps` JSONB column (contract type
  `BackupDatabaseDumps`), surfaced on `GET /admin/tenant-bundles/:id`, with
  per-db status `dumped`/`degraded`/`failed` and bundle roll-up
  `ok`/`degraded`/`none` + `remediation`. This dump summary is a **separate
  dimension** from the bundle's `status`: a `completed` bundle can carry a
  `degraded` `database_dumps` and stays fully restorable via the raw-files
  floor — a degraded/failed logical dump never flips the bundle to `partial`
  and never blocks restore. Restore re-imports the logical dumps via the
  `databases-by-id` restore item (SQL through `importSqlFromPvcFile`, MongoDB
  `.archive.gz` through `mongorestore --archive --gzip --drop`), skipping
  gracefully when a DB pod is down or no dump exists; raw datadir restore
  stays available via `files-paths`. New operator runbook:
  `docs/operations/DATABASE_RECOVERY.md`.
- **`platform-secrets` mirror drift-guard** — `platform-secrets` lives in the
  `platform` namespace but the sftp-gateway runs in `platform-system` and mounts
  a mirrored copy (k8s has no cross-namespace secret refs). Bootstrap mirrored it
  **once** (skip-if-exists), so rotating the `platform` source left the
  `platform-system` copy stale — the gateway's `internal-secret` then no longer
  matched platform-api's `PLATFORM_INTERNAL_SECRET` and **every SFTP auth 403'd,
  silently, for all tenants** (found on DEV 2026-07-02, drifted since the
  06-22 rebuild; nothing had exercised SFTP). Now drift-proofed three ways:
  platform-api re-asserts the mirror on boot (`reconcilePlatformSecretsMirror`,
  mirrors the mail-master auto-heal shape), the sftp-gateway Deployment carries a
  `secret.reloader.stakater.com/reload: platform-secrets` annotation so a heal
  auto-restarts it, and `bootstrap.sh` now reconciles the mirror every run
  instead of skipping when present.
- **Webmail master-credential drift detection + self-heal** (`mail-drift`) — the
  principals-sync detector now VERIFIES the Stalwart master (`master@<sentinel>`)
  can authenticate, not just that it exists. A master that is present but whose
  password has drifted out of sync with `mail-secrets` (e.g. a Stalwart
  redeploy/restore that reset the account — the 2026-07-01 staging incident) is
  flagged AND **auto-healed**: the detector re-asserts the `mail-secrets`
  password onto Stalwart (no new password, no webmail roll) so a reset can never
  leave impersonation persistently broken. Kill-switch `MAIL_MASTER_AUTOHEAL=disable`.
  New `verifyMasterJmapAuth`, `readStalwartMasterPassword`,
  `reconcileStalwartMasterCredential`; `rotate-jmap` gains `explicitPassword`.

### Fixed
- **Mail failback no longer hangs when the target node is still recovering**
  (`mail-dr`, failback reliability) — a failback consistently timed out at
  `scaling-up` ("pod did not become Ready within 600s"). Root cause (pinned on live
  destructive runs 2026-07-04, via the new diagnostics below): a failback fires
  while the target node is still coming back from the k3s restart it took during the
  preceding failover — it reports **NotReady with `node.kubernetes.io/{not-ready,
  unreachable}` taints**, which blocks BOTH local-path provisioning (`pvc=Pending
  vol=<unbound>`) AND pod scheduling (untolerated taint), so the whole migration
  burns the full 600s timeout. Two composed fixes:
  1. **Target-node-readiness gate** — preflight now waits (before any destructive
     swap) for the target node to be `Ready` with its recovery taints cleared, so a
     migration never tears down the source for a node that isn't schedulable yet;
     a target that never recovers fails the migration cleanly. No-op for an
     already-Ready target.
  2. **Stale-provisioner bounce** — once the node is Ready, the single-replica
     local-path provisioner can still be stale toward it (`create process timeout
     after 120s` / `failed to save logs: … resource name may not be empty`), so the
     fresh PVC never binds. After scale-up the migration polls the target PVC and,
     if it stays unbound past a grace window, bounces the provisioner pod (its
     ReplicaSet recreates it — the Flux-safe restart pattern; proven to bind the PVC
     within seconds) up to a bounded number of times.

  A scaling-up timeout also now captures the pod's Pending/Unschedulable reason,
  init/container waiting reasons, the PVC bind state, and recent Warning events into
  the run error — previously the only signal was the opaque "did not reach 1 ready
  replica" (this diagnostic is what pinned the root cause). A defensive sweep of any
  Released/Available `mail-stack-data` orphan pinned to the target node (data-safe,
  target-scoped, never the retained source or a Bound PV) also runs before recreating
  the PVC.
- **Mail snapshots can no longer poison `latest` with an empty (0-byte) capture**
  (`mail-dr`, snapshot integrity) — a restic snapshot fired during a DR PVC-swap
  window (or after a failed failback left mail down) captured an empty DataStore;
  `latest` then pointed at it and the `restore-state` init FATAL'd "Snapshot is
  malformed" and crash-looped. Two-sided fix: (1) `snapshot-upload.sh` refuses to
  back up unless the RocksDB `CURRENT` sentinel is present, so an empty/mid-swap
  store is never snapshotted; (2) the `restore-state` init walks candidate
  snapshots newest→oldest and skips any empty/malformed one, falling back to the
  newest snapshot that actually holds a DataStore (a pinned per-snapshot restore is
  still honored exactly, never silently substituted).
- **Webmail impersonation heals AT cutover after a failover** (`mail-dr`) — a
  restore brings Stalwart up with the SNAPSHOT's master-account password,
  drifted from `mail-secrets`, so Bulwark/Roundcube impersonation was broken for
  all mailboxes until the slow principals-sync auto-heal tick caught it
  (post-failover master-auth could stay broken for minutes). The migration
  cutover now re-asserts the `mail-secrets` master password onto Stalwart
  immediately (Step 8b1b, mirroring the admin re-sync), so impersonation heals
  at cutover regardless of the flag-gated security-hygiene master rotation.
- **Mail failover no longer loses snapshot-captured mail to a stale standby
  copy** (`mail-dr`, restore freshness) — the failover restore's FAST PATH
  copied the standby-rsync pre-staged data and skipped restic whenever the
  standby marker was younger than `STANDBY_MAX_AGE_SECONDS` (30 min). But a
  recent marker only means the last rsync *finished* recently, not that its
  data contains the latest deliveries — a message delivered after the last
  rsync yet captured in a snapshot was absent from the standby copy, so a
  failover could restore data up to 30 min stale and drop mail that a *fresher*
  snapshot held. The restore-state init now compares the standby marker against
  the latest restic snapshot's time and rejects the FAST PATH (restoring the
  snapshot via restic) whenever the snapshot is newer — so snapshot-captured
  mail always survives a failover.
- **Mail failover now verifies the TLS cert is actually *served*, not just
  issued** (`mail-dr`, issuance≠serving) — after a failover/DR cutover the
  reconcile fires the ACME order, but Stalwart binds a freshly-issued cert to
  its `:465` listener on its own reload cadence (observed ~1h lag), so a
  failover could complete while the node still served the bootstrap self-signed
  `rcgen` cert — and mail was reported "healthy" over it. The cutover now polls
  the served cert (`waitForServedMailCert`); if still self-signed after the
  issuance grace it recycles Stalwart once to reload the stored cert, and a
  persistent failure fires a loud operator alert (`notifyAdminsMailCertNotServing`)
  instead of a silent "healthy". The mail DR + external-reachability integration
  suites now poll the served cert (forcing a reconcile) and treat a persistent
  self-signed listener as a hard FAIL.
- **`local.host` master sentinel no longer flagged as an orphan-domain** — the
  drift detector excluded the mail-hostname anchor but not the sentinel Domain
  that holds the master; a `delete-orphan` on it would have destroyed the master
  and broken ALL impersonation.
- **Stalwart Domain teardown hardened** — `destroyStalwartArtifactsForEmailDomain`
  now retries the Domain destroy (3×, backoff) to ride out a transient Stalwart
  redeploy window and reports its outcome, cutting the orphan-domain pile-up left
  by best-effort tenant-delete cleanup.

### Security
- **cert-manager upgraded `v1.20.2 → v1.20.3`** (component-watch tier-0) — fixes
  **GHSA-8rvj-mm4h-c258** (HIGH): the default `cert-manager-edit` ClusterRole let
  namespace users create ACME `Challenge`/`Order` resources directly, enabling a
  crafted Challenge to supply attacker-controlled solver config (with acme-dns,
  disclosing DNS creds). Low reachability in our model (tenants have no kube-API
  access — all mutations go through platform-api), but a tier-0 HIGH with "all
  users should upgrade", so patched promptly. Tracked in `security/cve-ledger.yaml`.
- **undici upgraded to 6.27.0** (`npm audit fix`, within range) — clears the four
  backend HIGH advisories (Set-Cookie header injection, WS DoS, response-queue
  poisoning, SameSite downgrade) on the transitive `<=6.26.0` copy. The other
  undici moved 7.27.2→7.28.0. Backend unit suite green (5473). nodemailer's
  GHSA-p6gq-j5cr-w38f stays tracked as `not_affected` (the `raw` message option is
  unused; the fix is a breaking 8→9 major) — the temporary undici cve-ledger
  waivers are removed now that it's fixed in-tree.
- **Mail-stack images bumped** (component-watch tier-0): Stalwart `v0.16.9 → v0.16.11`
  (drop-in patch — encryption-at-rest, IDN/OAuth/IMAP-objectid features + DANE/TLS/JMAP
  fixes; no config/cert/port change), Bulwark webmail `1.6.7 → 1.7.6`, and Roundcube
  `1.6.16 → 1.7.1` (both digest-pinned). Validated against the staging cluster (Stalwart
  SMTP/IMAP/JMAP + webmail).

### Changed
- **Component-watch upstream-drift sweep (ADR-050).** Bumped six swept components
  to current upstream: **Stalwart `v0.16.11 → v0.16.12`** (DKIM2/DMARCbis +
  DANE/OIDC fixes), **VictoriaMetrics `v1.145.0 → v1.147.0`** (base Alpine
  3.23.4→3.24.1 security bump), **CNPG barman-plugin `v0.12.0 → v0.13.0`** (lz4
  base-backups, WAL-restore error classification; ObjectStore CRD schema
  unchanged), **Traefik chart `41.0.0 → 41.0.2`** (app v3.7.5→v3.7.6), and **CNPG
  chart `0.28.2 → 0.28.3`** (operator patch). The three Flux-managed images
  reconcile onto existing clusters automatically; the three `bootstrap.sh` chart
  pins reach existing clusters via host-migration `2026.7.1/0001`, which upgrades
  each release in place with `helm upgrade --reuse-values --version` (reuse-values
  is mandatory — a bare `--set` upgrade would reset Traefik's DaemonSet/hostPort/
  plugin/trustedIP values and tear down the ingress perimeter). Registry pins +
  `updated:` stamp refreshed. DEV-validated (all six live, system-db WAL archiving
  healthy through the barman + cnpg-operator rolls, ingress serves HTTP 200 through
  the rolled Traefik, migration idempotent on re-run). rclone `1.74.1 → 1.74.4`
  deliberately deferred (spans three coupled sites the code requires kept aligned).
- **Integration-test sprawl cleanup + coverage guard.** An audit found 33 of 71
  `scripts/integration-*.sh` wired into no orchestrator — ~half the E2E suite never
  ran and **8 scripts had bit-rotted** (testing removed routes: `mail/node-selector`,
  `mail/blob-store`, `/system-backup/runs`, `/catalog/entries?code=`, `companyEmail`,
  `tenants/bulk/delete`, the `thisNodeOnly` port-exposure enum). Added
  `scripts/integration-test-registry.txt` (every script categorized:
  suite/perf/local/manual/pending) + `ci-integration-coverage.sh` (a new
  `integration-*.sh` not in the registry fails Infrastructure CI — sprawl can't
  regrow) + a self-test. Deleted 3 dead scripts (`mail-ha-e2e` 7/13-dead,
  `backups-ui-phase-2026-05-24` dated, `tenant-bundles-jmap` subset-of-full-e2e);
  fixed two route/field bit-rots (`dr-bundle`, `tenant-bundles-restic`). The 21
  `pending` feature-E2E (each route-validated against the live backend) are tracked
  in the registry for staging-validated integration.
- **Tenant hard-delete returns promptly** (~68 s → single digits for a
  provisioned tenant). `DELETE /tenants/:id` blocked the request on two
  synchronous waits for the namespace's Longhorn PV to Release — neither of which
  *can* complete inside the request, because the namespace delete that releases
  the PV runs between them: (1) the `pv-cleanup-released` lifecycle hook polled up
  to 60 s for a PV that is still Bound at hook time (it runs before the namespace
  delete), and (2) the post-namespace-delete volume reap waited up to 45 s for the
  PV to Release. The hook now early-exits (~6 s) once it sees the PV can't release
  yet, the reap runs detached in the background, and the tenant row is dropped
  synchronously so the tenant disappears from the API immediately. Both cleanups
  still happen — via the reap + the 2-min lifecycle-hook scheduler retry +
  Orphaned-Volumes safety nets — just off the request path. This also stops
  concurrent deletes from piling up slow requests on the API.
- **external-snapshotter upgraded v6.3.0 → v8.6.0** (latest stable). The
  running snapshot-controller on staging was actually v6.2.1 — even older
  than the previous pin claimed. v8 requires k8s ≥ 1.25 (CRD CEL validation
  rules); clusters run 1.35. This is a pin bump in `scripts/bootstrap.sh`
  plus a re-apply of the upstream CRDs + RBAC + snapshot-controller
  Deployment, and it realigns the controller with the v8.x CRD set already
  referenced by `k8s/base/longhorn/csi-snapshots.yaml`. Safe by inspection:
  the VolumeSnapshot storage version has been v1 since external-snapshotter
  v4.1, no v1beta1 objects exist (CRDs already serve v1 only), so the CRD
  update is additive; VolumeGroupSnapshot CRDs are intentionally omitted
  (the controller is Ready on the v1 CRD set alone). Underpins the CNPG
  snapshot-PITR path and the Longhorn `VolumeSnapshotClass`.
- **Bootstrap-pinned infra now upgrades existing clusters via a host-migration**
  (the path I previously hand-applied). A `bootstrap.sh` infra-version-pin bump
  reaches FRESH installs only — Flux/RC applies app overlays, never `bootstrap.sh`.
  So the external-snapshotter bump ships
  `platform/host-migrations/2026.6.19/0001-external-snapshotter-v8.sh` (ADR-045
  W10c): embedded in the signed `platform-ops` binary, run host-side by the
  `platform-ops host-config` converger in `enforce` (idempotent; exits 0 once the
  v8 selector is present; workers no-op via least-priv RBAC). New forcing function:
  `ci-migration-coverage.sh` now fingerprints the bootstrap **infra version pins**
  (k3s/Calico/Longhorn/Traefik/cert-manager/sealed-secrets/CNPG/Flux/snapshotter)
  alongside the firewall shape — any pin bump without a matching host-migration
  fails the build.
- **`platform-ops self-upgrade` now converges host-migrations immediately**
  (apply-on-Apply). After a successful binary self-upgrade it re-execs the
  just-replaced binary as `host-config apply`, so the new release's
  host-migrations apply on the same cycle instead of waiting for the next daily
  `platform-ops-host-config.timer`. Best-effort (the timer remains the backstop,
  so a converge failure never fails the upgrade) and SEA-only; no `--apply`, so
  each host-config surface still honours its own enforce/observe policy.

### Fixed
- **Mail migration to a worker node no longer deadlocks — and never loses mail data.**
  Migrating the active mail node could hang at `swapping-pvc` ("failed to delete
  source PVC after 120 s — finalizer stuck") when a pod on a *healthy* node held the
  source PVC's `pvc-protection` finalizer open — a Running/Completed snapshot pod or
  a Pending Stalwart pod. The previous escalation only force-deleted pods on *dead*
  nodes, so it missed these, and the rollback then scaled Stalwart back up onto the
  still-Terminating PVC → permanent deadlock (pod Pending forever, PVC never deletes)
  → mail down on every node (observed migrating to the worker node, 2026-06-30).
  Now `deletePvcAndWait` force-deletes EVERY pod referencing the PVC (any node, any
  phase) and, as a data-safe last resort, strips the `pvc-protection` finalizer —
  safe because the swap flips the source PV to `Retain` first, so the on-disk store
  survives the PVC-object removal; and the rollback force-completes a stuck-Terminating
  PVC before re-binding the retained PV. The retained source PV preserves the mail
  store throughout, so no migration failure path can lose data.
- **Mail migration no longer fails when Stalwart's graceful shutdown is slow.**
  The node-swap migration scaled Stalwart to 0 and waited only 90 s for the
  Deployment to reach 0 ready replicas, but the pod's
  `terminationGracePeriodSeconds` is 300 s and its SIGTERM path drains live
  connections (incl. the haproxy backend health checks on the dedicated PROXY
  listeners), which can exceed 90 s — failing the migration at `scaling-down`
  ("did not reach 0 ready replica(s) within 90 s"). The scale-down now keeps the
  90 s graceful window, then **force-deletes (grace 0) the mail pod(s) still
  mounting the source PVC** to guarantee it releases for the swap. Data-safe: the
  pre-migration snapshot already captured the store and the source PV is retained
  (rollback-safe), and RocksDB recovers via its WAL after a SIGKILL. Operator
  cancel is still honoured.
- **Mail migration is now data-safe on local-path volumes.** The node-swap
  migration deleted the source `mail-stack-data` PVC (StorageClass `local-path`,
  `reclaimPolicy: Delete`) *before* the destination was confirmed populated, and
  had **no rollback** — so a stuck-finalizer delete (or any post-delete failure)
  wiped the only live copy of the mail store, surviving only because of an
  out-of-band restic snapshot (data-loss incident 2026-06-28). The swap now flips
  the source PV to `Retain` **before** the delete (data survives regardless), and
  every post-delete failure path (PVC-delete fail, target-PVC create fail, affinity
  fail, scale-up/cancel, restore-verify fail) rolls mail back onto the source's
  retained volume instead of leaving it on an empty disk; the retained PV is GC'd
  only after the destination is verified.
- **External mail to non-active nodes works (the real multi-node fix).** On a
  multi-node cluster, external mail to a NON-active node was accept-then-dropped.
  Root cause: the `stalwart-mail` Service carried `externalIPs` = the non-active
  node IPs, and kube-proxy's externalIP PREROUTING DNAT **preempted the haproxy
  hostNetwork socket entirely** — haproxy received zero external traffic and mail
  was DNAT'd straight to the Stalwart pod, so `send-proxy-v2` never ran and the
  real client IP was lost. Calico/WireGuard then masqueraded every cross-node
  client to the origin node's pod-network tunnel IP (10.42.x), so all external
  clients collapsed onto ONE tunnel IP hitting six mail ports → Stalwart's
  `portScanning` autoban permanently banned that tunnel IP and **mail died on the
  node**. The previous PROXY-v2 trust (node public IPs) targeted an address
  Stalwart never saw cross-node, so it never worked. Fix: platform-api now resolves
  the Service externalIPs to `[]` (haproxy receives external mail directly via its
  hostPorts); Stalwart gains six DEDICATED PROXY-protocol listeners
  (12025/12465/12587/12143/12993/14190) that trust the cluster **pod CIDR**; and the
  haproxy backends repoint to those listeners with `send-proxy-v2`. Stalwart now
  parses the PROXY header from the (masqueraded) pod-CIDR source and recovers the
  **real client IP**, so SPF/DKIM and the port-scan autoban operate on real IPs.
  The standard mail listeners stay PROXY-free for the active-node hostPort path and
  in-cluster direct clients (Roundcube, Bulwark, health probes). Newly-created
  proxy listeners are bound via a one-time Stalwart recycle on first creation.
  **Reverts** the prior `proxy-networks-reconciler` "track pod identity + recycle
  on trust write" self-heal (`v2026.6.18-rc.8`) — it was built on the disproven
  theory that haproxy fronted the mail ports and Stalwart saw node IPs.
- **Inbound mail (MX, port 25) now accepted on the haproxy/non-active nodes.** The
  dedicated `smtp-proxy` listener (port 12025) inherited Stalwart's default
  `MtaStageAuth.require` (`require auth when local_port != 25`), so it rejected
  unauthenticated inbound `MAIL FROM` with `503 must authenticate first` — breaking
  real external mail delivery on ~2/3 of nodes (round-robin). The domain reconciler
  now sets `MtaStageAuth.require.else` to `local_port != 25 && local_port != 12025`,
  so port 12025 is treated as a no-auth inbound MX like port 25 (submission/IMAP
  proxy listeners stay auth-required). Applied via the same one-time Stalwart recycle
  that binds the proxy listeners.
- **Snapshot archives no longer leak when a tenant is hard-deleted.** The
  snapshot-store purge ran *after* the delete cascade dropped the tenant row, but
  `storage_snapshots` cascade-deletes with the tenant — so the purge queried zero
  rows and the archives were orphaned in the store forever. The purge now runs
  *before* the row drop, while the snapshot records still exist.
- **Integration harness robustness.** `drain` no longer hard-fails on best-effort
  Longhorn replica-record GC lag (it warns instead; the real drain invariants —
  active replicas + workloads moved off the node — still fail hard); the `pvc`
  suite treats a 404-after-retry on a tenant DELETE as an idempotent success;
  and `integration-cleanup.sh` now matches every test-tenant name format (by the
  reserved `example.test` email domain + a trailing epoch) so stale test tenants
  can't accumulate and trip the leak guard.
- **Mail integration probes survive a Stalwart roll/migration.** The harness
  allowlists its public IP in Stalwart's `x:AllowedIp` so its rapid multi-port
  mail probes (25/465/587/993/4190) aren't accept-then-dropped by the port-scan
  autoban. A one-time guard meant the allowlist was never re-armed after a
  scenario rolled or migrated Stalwart (`mail_hostname_rename`,
  `mail_migration_fixes`) — and a node-swap onto a fresh RocksDB store drops the
  entry, so every later mail probe banned the harness IP (the recurring
  `staging-all` mail-flake tail). The allowlist helper now takes a `force`
  argument that re-registers + unbans + reloads after each roll (a cheap no-op
  when the entry survived); `mail_tls`, `mail_hostname_rename`, and
  `mail_migration_fixes` call it post-roll.
- **`mail_hostname_rename` is reproducibly green and stops burning LE certs.**
  The scenario hard-failed on two checks that race *external* Let's Encrypt
  issuance under load: a `defaultHostname` read via the `stalwart-mgmt` *service*
  (empty while the rollout's endpoint was unready) and a cert-SAN poll (LE took
  longer than the budget). Investigation showed the rename itself is fast
  (backend applies it + triggers ACME in ~21 s; Stalwart's `defaultHostname`
  updates in ~15 s; pod Ready ~40 s) — the only slow phase is LE issuance, which
  the platform doesn't own in-window. Fix, split by responsibility: the
  `defaultHostname` check now reads the pod **loopback** JMAP (up the instant the
  pod is Ready, ~15 s) and the SMTP-465 banner stays a **hard** gate — these prove
  the platform applied the rename; cert-SAN coverage is now **advisory**
  (`certfail`, promotable with `MAIL_RENAME_CERT_STRICT=1`) since it depends on
  external LE. Also, the test host is now a **stable** `mail-e2e-rename.<apex>`
  instead of a per-run timestamp: LE rate-limits per *registered domain*, so
  unique names burned a fresh cert every run (≈14 leftover anchor rows found on
  staging); a fixed name lets Stalwart cache and reuse the cert. Validated: two
  back-to-back runs 7/0 in ~56 s each (was ~9 min with 2 failures).
- **Integration harness: the full `integration-all.sh` parallel run no longer
  self-inflicts failures.** Root-caused 2026-06-27: platform-api stays up through
  the whole parallel group — its only restarts come from `postgres-pitr`'s
  by-design system-db recreate in the terminal serial phase, not parallel load.
  Two test-side fixes remove the remaining noise: (1) the control-plane barrier's
  `set -e` no longer leaks out of the serial group and abort the entire run on a
  single platform-api blip; (2) rate-limit contention is absorbed — all 12
  parallel suites share one admin identity (so one global-limiter bucket) and one
  source IP, so the `pvc` suite's tenant DELETEs now retry transient 429s, and the
  **staging overlay** raises `API_RATE_LIMIT` + `AUTH_LOGIN_RATE_LIMIT_MAX` for
  the synthetic batch (staging only — production keeps the defaults; the
  rate-limit-testing suites are unaffected).

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
