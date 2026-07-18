#!/usr/bin/env bash
# Master integration runner — executes every E2E harness in sequence
# against the staging cluster. Exits non-zero on the first failure but
# always reports a final summary so a CI run shows which suites broke.
#
# Suites:
#   1. integration-staging.sh all   — lifecycle / fm / https / reprovision
#   2. integration-pvc.sh           — PVC + tier + cascade race
#   3. integration-tier-flip-e2e.sh — full tier flip + storage placement + fsType + fsck
#   4. integration-grow-e2e.sh      — online grow (PATCH storage_limit_override)
#
# USAGE
#   ADMIN_PASSWORD=<…> ./scripts/integration-all.sh
#
# All connection settings are env-overridable. To run against a non-
# example.test cluster (e.g. testing.example.test), pass:
#   SSH_HOST=root@<ip>                      [default: root@192.0.2.56]
#   SSH_KEY=/path/to/key                    [default: ~/hosting-platform.key]
#   ADMIN_HOST=https://admin.<domain>       [default: phoenix staging]
#   ADMIN_EMAIL=admin@<domain>              [default: admin@example.test]
#   ADMIN_PASSWORD=<…>                      [REQUIRED]
#   HTTPS_TEST_DOMAIN_BASE=<wildcard zone>  [default: staging.example.test]
#                                           Must wildcard-resolve to the cluster
#                                           ingress IPs; required by the HTTPS
#                                           tenant-provisioning scenario.
#   CATALOG_NGINX_PHP=<UUID>                [default: seeded UUID; lookup via
#                                           GET /api/v1/catalog?limit=200 if
#                                           your cluster's catalog differs]
#
# CONTROL_HOST (the SSH target for cluster-internal kubectl probes) is
# auto-derived from SSH_HOST; override only if your control plane is
# reachable on a different IP than the bastion.

set -uo pipefail

# Config profile: load the operator's gitignored scripts/integration.env (real
# cluster coordinates + any confidential external-target creds) and EXPORT every
# value, so the sub-scripts launched below inherit it without a committed default.
# See scripts/integration.env.example.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"
load_integration_env
# shellcheck source=scripts/lib/integration-lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-lib.sh"

# Auto-install the workstation CLI tools the suites need (ncat, age, sshpass,
# restic, dnspython, …) so a fresh checkout runs with no manual apt-get. Warm
# path is a no-op; opt out with INTEGRATION_SKIP_DEP_INSTALL=1.
# shellcheck source=scripts/lib/ensure-workstation-deps.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/ensure-workstation-deps.sh"
ensure_workstation_deps

# ─── runner options (P3 selection + per-suite hard timeout · P4 report) ─
# Backward-compatible: with no flags the run behaves exactly as before
# (smoke gate + every suite). Flags let you slice the suite and bound
# wall-clock per suite so one hung harness can't stall the whole run.
TIER_FILTER=""        # comma list of suite tiers to include: core,slow,external (empty = all)
ONLY=""               # comma list of suite names — overrides tiers
EXCLUDE=""            # comma list of suite names to drop
LIST=0                # --list: print the resolved selection and exit
RUN_SMOKE=1           # run smoke-test.sh first and abort on red
DEFAULT_SUITE_TIMEOUT="${INTEGRATION_SUITE_TIMEOUT:-1800}"  # per-suite hard cap (s)
REPORT_JSON="${INTEGRATION_REPORT_JSON:-}"                  # machine-readable run report path
RUN_STARTED_TS=$(date +%s)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier)        TIER_FILTER="$2"; shift 2 ;;
    --only)        ONLY="$2"; shift 2 ;;
    --exclude)     EXCLUDE="$2"; shift 2 ;;
    --timeout)     DEFAULT_SUITE_TIMEOUT="$2"; shift 2 ;;
    --report-json) REPORT_JSON="$2"; shift 2 ;;
    --no-smoke)    RUN_SMOKE=0; shift ;;
    --list)        LIST=1; shift ;;
    -h|--help)
      sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      cat <<'USAGE'

Runner flags:
  --tier <t[,t...]>      run only suites in tiers: core | slow | external
                         (special: --tier smoke runs ONLY the smoke gate)
  --only <name[,...]>    run only the named suites (overrides --tier)
  --exclude <name[,...]> skip the named suites
  --timeout <seconds>    per-suite hard timeout (default 1800; per-suite overrides apply)
  --no-smoke             skip the smoke-test.sh pre-gate
  --report-json <path>   write a machine-readable JSON run report
  --list                 print the resolved suite selection and exit
USAGE
      exit 0 ;;
    *) echo "unknown arg: $1 (try --help)" >&2; exit 2 ;;
  esac
done

ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
[[ "$LIST" == 1 ]] || require_env ADMIN_PASSWORD
ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
# Some suites (private-worker, …) key off TENANT_BASE for the tenant wildcard;
# default it to the same wildcard the rest of the run uses (HTTPS_TEST_DOMAIN_BASE)
# so it resolves to the cluster ingress instead of the unresolvable example.test.
export TENANT_BASE="${TENANT_BASE:-${HTTPS_TEST_DOMAIN_BASE:-}}"

CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log()   { printf '\n%b═══ %s ═══%b\n' "$CYAN" "$*" "$RESET"; }
pass()  { printf '%b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
fail()  { printf '%b✗%b %s\n' "$RED" "$RESET" "$*"; }
warn()  { printf '%b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }

# Reset admin password ONCE up front (was: per-suite). Pod restarts can
# cycle the bcrypt hash; a stale password kills login. We reset once
# because the cached INTEGRATION_TOKEN we issue below survives the
# whole run — sub-scripts inherit it, no per-suite re-login.
reset_admin_password() {
  # ssh joins its trailing args into ONE string the REMOTE shell re-parses, so a
  # quote/metachar in the credentials would break out of the quoting — a password
  # like  it's; rm -rf …  would both fail auth and run on the node. printf %q
  # shell-quotes each value safely for that remote re-parse.
  local eq pq
  eq=$(printf '%q' "${ADMIN_EMAIL:-}")
  pq=$(printf '%q' "${ADMIN_PASSWORD:-}")
  ssh -i "${SSH_KEY:-$HOME/hosting-platform.key}" \
    -o StrictHostKeyChecking=no -o ConnectTimeout=10 -q \
    "${SSH_HOST:-root@192.0.2.56}" \
    "/tmp/admin-password-reset.sh --email $eq --password $pq >/dev/null 2>&1" \
    || warn "admin password reset failed — auth may fail in suite"
}

# Single login → INTEGRATION_TOKEN. Sub-scripts inherit via export
# and skip their own /auth/login round-trip (see
# `lib/integration-token.sh` and individual scripts' login_token()).
# Default access token TTL is 30 minutes; we refresh between major
# parallel groups (~midway through a full run) to stay well within
# that window. Sub-scripts that get a 401 fall back to fresh login
# (their existing curl path is the else-branch of the cache check).
# 2026-06-24 (#130): delegate to the shared, cache-backed, 429-resilient token
# helper so the whole run reuses ONE token (re-minted only when it nears
# expiry, with backoff on rate-limit). Sub-suites source the SAME helper and
# read the SAME cache file, so neither the long ALL run nor rapid single-suite
# runs storm /auth/login. Re-minting before each group (below) keeps the
# inherited INTEGRATION_TOKEN fresh for any suite that hasn't migrated yet.
mint_token() {
  source "$(dirname "${BASH_SOURCE[0]}")/integration-token.sh"
  get_admin_token
}
# force_mint: returns a FRESH, full-TTL token (ignores + refreshes the shared
# cache). get_admin_token reuses a cached token while it's >120s from expiry,
# so a "refresh" before a LONG phase returns a near-dead token and the phase
# dies mid-flight (the INVALID_TOKEN cascade). Use this at phase boundaries.
force_mint() {
  source "$(dirname "${BASH_SOURCE[0]}")/integration-token.sh"
  force_mint_token
}
if [[ "$LIST" == 0 ]]; then
  reset_admin_password
  INTEGRATION_TOKEN="$(mint_token)"
  [[ -n "$INTEGRATION_TOKEN" ]] || { echo "ERROR: initial login failed" >&2; exit 2; }
  export INTEGRATION_TOKEN
  log "Cached INTEGRATION_TOKEN (sub-scripts will skip per-suite login)"
fi

# Suite layout: SERIAL groups + PARALLEL groups. Layout chosen to keep
# global-state-mutating suites (staging-all, oidc-dex, postgres-pitr)
# off the parallel path, where their effects on the shared cluster
# would corrupt sibling suites' assertions.
#
# SERIAL_PRE  — must run first, sequentially, against an unmolested
#               cluster. staging-all owns the global integration
#               fixture (admin/billing/support users, backup target,
#               canonical plan/region IDs); oidc-dex toggles Dex
#               static-providers + proxy-gate cluster state.
# PARALLEL    — operate on independent tenant namespaces with no
#               cross-suite state sharing. Race-safe to run all at
#               once. Output is captured per-suite and replayed on
#               completion so the operator can scroll through one
#               cohesive log per suite.
# SERIAL_POST — destructive / terminal. postgres-pitr deletes and
#               recreates the platform/postgres CR — must be the last
#               thing the cluster sees.
#
# 2026-05-17 baseline: a full serial run was ~45 min on staging.
# Switching the PARALLEL bucket to background+wait drops typical
# wall time by ~50% (most parallel suites are 4-8 min apiece and
# converge close to the slowest one's wall time).

SERIAL_PRE=(
  "staging-all:integration-staging.sh all"
  "oidc-dex:integration-oidc-dex.sh"
  # trusted-proxies MUTATES the shared Traefik DaemonSet args (adds + removes a
  # test CIDR), which rolls ALL Traefik pods. It MUST run serially (alone) so it
  # never churns the DS while a sibling suite measures it — waf-crowdsec's
  # transient "DS coverage 3/4" failure (2026-06-25) was exactly this
  # concurrency (a Traefik pod caught mid-roll → numberReady N-1/N). ~30s.
  "trusted-proxies:integration-cluster-trusted-proxies.sh"
  # webmail-feature-toggle PATCHes the GLOBAL webmail_show_* settings; the
  # feature-css annotation change rolls BOTH webmail Deployments → must run
  # serially (never alongside a suite that reads a Ready bulwark pod). Restores
  # defaults on completion. Validated on DEV 2026-06-30. ~30s.
  "webmail-feature-toggle:integration-webmail-feature-toggle.sh"
  # Mailbox-backup engine selector (api-smoke): PATCH + GET round-trip of the
  # GLOBAL mailbox_backup_engine setting (imap/jmap). Serial because it mutates
  # a global setting; saves + restores the original so it's non-mutating. The
  # heavy mailboxes-only/full modes (real S3 bundle round-trip) stay manual/on
  # demand. Staging-validated. ~5s.
  "tenant-bundles-engine:integration-tenant-bundles-engine-e2e.sh api-smoke"
)
PARALLEL=(
  "pvc:integration-pvc.sh"
  "tier-flip:integration-tier-flip-e2e.sh"
  "grow:integration-grow-e2e.sh"
  # Per-mailbox quota + per-plan max mailbox size: default-to-max on
  # create, reject-over-max on create/update, per-tenant override, usage
  # endpoint. Creates a disposable tenant + email domain, cleans up via
  # trap. ~1-2 min.
  "mailbox-quota:integration-mailbox-quota-e2e.sh"
  "passkey:integration-passkey-e2e.sh"
  # Tenant SFTP reachability at the ADVERTISED files.<apex>:23022 — provisions
  # its own probe tenant, then connects from OFF-cluster and round-trips a file.
  # Deliberately does NOT port-forward: the pre-2026-07-15 bugs (LoadBalancer
  # stuck <pending> with servicelb disabled, no firewall accept, dev hostname
  # advertised) all lived in exactly the layers a port-forward skips, which is
  # why the port-forwarding sftp-gateway-e2e suite never caught them. Self-skips
  # (77) when the runner lacks sftp/sshpass. ~1-2 min.
  "sftp-reachability:integration-sftp-reachability.sh"
  "firewall:integration-firewall-e2e.sh"
  "drain:integration-drain-e2e.sh"
  # (waf-crowdsec moved to SERIAL_POST — it BANS the shared harness outbound IP
  #  to verify enforcement from the banned vantage, which collateral-403s every
  #  concurrent sibling's auth. It must run isolated, not in this batch.)
  # Admin node-terminal: full A→E flow + F (HA replica handoff) + G
  # (reconnect contract). Requires NODE_TERMINAL_ENABLED=true on the
  # target platform-api and step-up freshness — pass --bump-freshness
  # via env or pre-bump via INTEGRATION_TOKEN. ~90s.
  "node-terminal:integration-node-terminal.sh --bump-freshness"
  # R-X5: universal backup-rclone-shim drain orchestration. Exercises
  # list / status / assign / drain-now plus 4 negative paths. Uses a
  # disposable backup_configurations row pointing at dev minio (or a
  # pre-existing S3 target on staging); CREATEs and DELETEs cleanly.
  # ~30s when the shim has no inflight tasks.
  "backup-rclone-shim:integration-backup-rclone-shim.sh"
  # R-X12: full DR drill — exercises the SYSTEM + MAIL shim round-trip
  # (assignment → ObjectStore → ScheduledBackup → CNPG plugin → etcd
  # CronJob → restic Secret) plus dry-run of all three restore scripts.
  # Cleans up after itself via trap. ~2 minutes on a healthy cluster.
  "dr-drill-shim:integration-dr-drill-shim.sh"
  # (trusted-proxies moved to SERIAL_PRE — it mutates the shared Traefik DS and
  #  must not run concurrently with suites that measure it, e.g. waf-crowdsec.)
  # ADR-051 monitoring stack: VMUI auth gate + scrape health, SLO admin
  # API, the admin.slo_alert_* notification sources (#56), and an
  # induced cnpg-down fire→notify→resolve lifecycle incl. the #57
  # email-row no-silent-loss contract. Non-disruptive (threshold
  # override only, cleared via trap) but the alert leg waits out
  # cnpg-down's forSeconds=300 → ~9-12 min wall; self-skips (77) on
  # overlays without k8s/base/monitoring (e.g. local DinD).
  "monitoring-slo:integration-monitoring-slo.sh"
  # mTLS edge enforcement (ADR-054): provisions a throwaway tenant +
  # nginx-php deployment + domain (auto-route) + CA provider, binds mTLS,
  # then asserts via real curl that no-cert is handshake-rejected, a valid
  # cert passes the gate, and a revoked cert gets 403 (per-cert) + the CRL
  # lifecycle. Needs HTTPS_TEST_DOMAIN_BASE (the staging wildcard). Slow
  # (~8-12 min: deployment provisioning + LE cert issuance), comparable to
  # monitoring-slo above; self-cleans via trap. Staging-validated 17/17.
  "mtls:integration-mtls-e2e.sh"
  # ADR-037 asymmetric QoS: asserts the tenant ResourceQuota shape (requests.cpu
  # + limits.memory, NO limits.cpu), multi-component allocation, per-container
  # Burstable-CPU/Guaranteed-memory, and that an over-allocation is rejected at
  # pod-admission by the quota (not a sync 4xx). Disposable tenant, trap cleanup.
  # Uses SSH kubectl (SSH_HOST from integration.env). Staging-validated 10/10. ~2 min.
  "burstable-qos:integration-burstable-qos.sh"
  # Platform-driven webmail E2E: provision tenant→domain→email→mailbox, mint the
  # webmail token, follow the SSO URL, and (bulwark) run the SPA-equivalent JMAP
  # probe — the real "open webmail as a tenant" path incl. master-user
  # impersonation. Disposable tenant, trap cleanup. Staging-validated 15/0. ~3-4 min.
  "webmail-platform:integration-webmail-platform-e2e.sh"
  # Bulwark native impersonation handler (A: pod health, B: happy path incl. the
  # #296 JMAP Mailbox/get read via master-auth, C: 14 negative JWT cases). Runs
  # in-pod via kubectl, no tenant provisioning, self-skips (77) if bulwark is
  # scaled to 0 (roundcube-active). Staging-validated 26/0. ~1-2 min.
  "bulwark-impersonate:integration-bulwark-impersonate.sh"
  # System DR bundle: triggers a real export run, downloads it, and (external-
  # tier) decrypts with the operator AGE key → verifies tar + sidecars + E2
  # readOnly freeze + secrets. Phase A (export+download) staging-validated;
  # self-skips (77) when the `age` binary / AGE_KEY_FILE are absent (public
  # clone / CI). Runner needs psql (Phase G) + tsx (Phase H) — those self-skip too.
  "dr-bundle:integration-dr-bundle.sh"
  # System Backup Phase 1: secrets-bundle export → one-shot signed download URL
  # (sha256 byte-match) → 410-Gone single-use enforcement → fresh export yields a
  # new runId → audit rows → postgres-restore route smoke. Read-mostly (exports a
  # bundle). The age-decrypt content check is external-tier and soft-skips when
  # AGE_KEY isn't the operator recipient (bundle bytes already proven in step 5).
  # Staging-validated 2026-07-01. ~10s.
  "system-backup:integration-system-backup.sh"
  # Multi-engine tenant-bundle DB logical-dump capture + restore: provisions a
  # probe tenant with add-on MariaDB + MongoDB (+ a SQLite file on the PVC),
  # captures one whole-client bundle, asserts the `database_dumps` operator
  # summary (status=ok, each engine dumped) + the per-engine dump artifacts on
  # the PVC, then corrupts + re-imports via the databases-by-id restore item.
  # Self-skips (77) when no offsite BackupStore is assigned to the 'tenant'
  # class. slow tier (two DB deploys + capture + restore).
  "db-dumps:integration-db-dumps-e2e.sh"
  # ─── Previously-manual suites, now wired (2026-07-16) ───────────────
  # All self-provision a disposable probe tenant and self-clean via trap, so
  # they're PARALLEL-safe (destructive only to their OWN tenant). They need an
  # offsite BackupStore assigned to the relevant shim class (present on staging)
  # and reach the cluster over SSH (SSH_HOST) or the $KUBECTL shim; they self-
  # skip (77) when a precondition (BackupStore, add-on plan, image) is absent.
  #
  # DR restore family — capture→simulate-loss→recover from the offsite bundle.
  # Restore uses the backup-rclone-shim; the 2026-07-16 --dir-cache-time fix is
  # required for SFTP/CIFS stores (else restore 404s on a durable snapshot).
  "dr-tenant-restore:integration-dr-tenant-restore-e2e.sh"
  "dr-database-restore:integration-dr-database-restore-e2e.sh"
  "dr-recover-all:integration-dr-recover-all-e2e.sh"
  "migration:integration-migration-e2e.sh"
  # Tenant-bundle restic round-trip (external-tier: soft-skips without S3 egress).
  "tenant-bundles-restic:integration-tenant-bundles-restic.sh"
  # Custom deployments (ADR-036) + private worker — provision workloads.
  "custom-deployments:integration-custom-deployments.sh"
  "custom-deployments-phase2:integration-custom-deployments-phase2.sh"
  "private-worker:integration-private-worker.sh"
  # (mailbox-aux moved to opt-in — it needs node-side seed files /tmp/mpw +
  #  /tmp/mfqdn that the auto-runner does not create; see the INCLUDE block.)
  # System backup bundle coverage + backups admin UI.
  "bundle-coverage:integration-bundle-coverage.sh"
  "backups-ui:integration-backups-ui.sh"
)
SERIAL_POST=(
  # waf-crowdsec BANS the shared harness outbound IP (Phase 4, ~3 min) to verify
  # ban enforcement from the banned vantage, then unbans + waits for cache flush.
  # While that ban is live, EVERY sibling suite authenticating from the same
  # harness IP gets collateral 403s — proven 2026-07-16 (dr-drill-shim B1
  # "create target HTTP 403", node-terminal K1, db-dumps/system-backup/
  # webmail-platform login 403). So it CANNOT run in the parallel batch; it runs
  # here, isolated, and before the destructive postgres-pitr so it sees a healthy
  # cluster. (The cap that fixed the storage-suite contention shifted the ban
  # window onto sibling logins, surfacing this latent interference.)
  "waf-crowdsec:integration-waf-crowdsec.sh"
  # ─── Global-state mutators that are SAFE to auto-run (serial, restore via
  # trap, before the destructive DB op). The staging-destabilizing globals
  # (mail-exposure toggle, master-cred rotation, barman system-db wipe) are
  # NOT here — see the INTEGRATION_INCLUDE_DISRUPTIVE block below.
  #   firewall-blacklist: bans reserved TEST-NET 203.0.113.222, self-lockout
  #     422-guarded, trap-unban. Touches the cluster firewall → serial.
  "firewall-blacklist:integration-firewall-blacklist.sh"
  #   dr-protocols: offline etcd break-glass READ path over S3/SFTP/CIFS
  #     (never restores etcd). Non-destructive; self-skips without node creds.
  "dr-protocols:integration-dr-protocols.sh"
  # ─── Destructive to system-db — deletes + recreates it (reclaimPolicy=Retain
  # so data survives) via native WAL-archive PITR. Runs LAST.
  "postgres-pitr:integration-postgres-pitr.sh"
)

# 2026-05-17: lifecycle (integration-lifecycle-e2e.sh) and system-
# snapshots (integration-system-snapshots.sh) suites exercise the
# storage-lifecycle snapshot Job, which uses LocalHostPathStore's
# inline `hostPath` volume — rejected by PodSecurity baseline on tenant
# namespaces (the snapshot Job runs in tenant ns to mount the source
# PVC). Re-enable by setting INTEGRATION_INCLUDE_SNAPSHOTS=1 once the
# PSA-compatible snapshot-store work lands. Lifecycle goes to
# PARALLEL (operates on its own tenants); system-snapshots stays
# SERIAL_PRE because it mutates the system-db cluster.
if [[ "${INTEGRATION_INCLUDE_SNAPSHOTS:-}" == "1" ]]; then
  SERIAL_PRE+=("system-snapshots:integration-system-snapshots.sh")
  PARALLEL+=("lifecycle:integration-lifecycle-e2e.sh")
fi

# Failure-injection suites (opt-in via INTEGRATION_INCLUDE_FAILURE_SUITES=1).
# Disruptive + must run serially, NEVER alongside the happy-path WAF suite:
#   • wal-archive-failure binds a DEAD backup target → CNPG restarts the primary
#     (platform-api flaps) → asserts the admin.wal_archive_failing alert fires and
#     the circuit-breaker stays untripped (the 2026-06-02 runaway guardrail).
#   • waf-failure briefly scales crowdsec + modsec-crs to 0 → asserts the API
#     reports the outage (502 / modsecPodFound=false) instead of silently passing.
# Prepended to SERIAL_POST so they run on a healthy cluster, before the terminal
# postgres-pitr deletes + recreates it.
if [[ "${INTEGRATION_INCLUDE_FAILURE_SUITES:-}" == "1" ]]; then
  SERIAL_POST=(
    "waf-failure:integration-waf-failure-e2e.sh"
    "wal-archive-failure:integration-wal-archive-failure-e2e.sh"
    "${SERIAL_POST[@]}"
  )
fi
# Staging-destabilizing global mutators — WIRED but opt-in
# (INTEGRATION_INCLUDE_DISRUPTIVE=1). Kept out of the default run because a
# mid-run failure degrades the SHARED cluster for other work (and the authors
# flagged them so): master-user-rotation tampers the webmail master (mail down
# until the ≤5m auto-heal); mail-external-reachability toggles mail
# port-exposure (golden-rule-4 territory); postgres-barman-restore WIPES +
# rebuilds the system-db (a 2nd destructive DB op on top of postgres-pitr);
# migration-cifs switches the tenant backup class to a CIFS target (rolls the
# backup-rclone-shim DaemonSet) to prove CIFS-source migration, then restores.
# All self-restore; run them deliberately. Prepended to SERIAL_POST.
if [[ "${INTEGRATION_INCLUDE_DISRUPTIVE:-}" == "1" ]]; then
  SERIAL_POST=(
    "mail-external-reachability:integration-mail-external-reachability.sh"
    "master-user-rotation:integration-master-user-rotation.sh"
    "postgres-barman-restore:integration-postgres-barman-restore.sh"
    "migration-cifs:integration-migration-cifs-e2e.sh"
    "${SERIAL_POST[@]}"
  )
fi
# Setup-heavy manual suites — WIRED but opt-in, because they need pre-run setup
# the auto-runner does NOT perform (would fail their preconditions otherwise).
# Prepended to SERIAL_POST (serial + before the destructive DB ops).
#   • mail-dr-* : need a labeled standby node + a mail-placement PATCH
#     (autoFailoverEnabled, secondaryNode) and mail off the DB/api node; they
#     STOP k3s on the active mail node to drive a real failover.
#     Env: MAIL_DR_NODE_MAP="name=ip,…". See the suite headers + registry notes.
if [[ "${INTEGRATION_INCLUDE_MAIL_DR:-}" == "1" ]]; then
  SERIAL_POST=(
    "mail-dr-failover:integration-mail-dr-failover.sh"
    "mail-dr-dataplane:integration-mail-dr-dataplane.sh"
    "mail-mobility:integration-mail-mobility-e2e.sh"
    "${SERIAL_POST[@]}"
  )
fi
#   • platform-domain-rename : needs RENAME_TARGET set (else read-only) + the
#     target apex to resolve; renames the shared platform apex mid-run.
if [[ "${INTEGRATION_INCLUDE_DOMAIN_RENAME:-}" == "1" ]]; then
  SERIAL_POST=("platform-domain-rename:integration-platform-domain-rename-e2e.sh" "${SERIAL_POST[@]}")
fi
#   • system-dr-drill : full platform cold-restore; run on a dedicated VM.
if [[ "${INTEGRATION_INCLUDE_SYSTEM_DR:-}" == "1" ]]; then
  SERIAL_POST=("system-dr-drill:integration-system-dr-drill.sh" "${SERIAL_POST[@]}")
fi
#   • mailbox-aux : orchestrator-level mailbox bundle E2E, but needs node-side
#     seed files (/tmp/mpw = STALWART_MASTER_PASSWORD, /tmp/mfqdn) written on the
#     target node before the run — the auto-runner doesn't create them.
if [[ "${INTEGRATION_INCLUDE_MAILBOX_AUX:-}" == "1" ]]; then
  PARALLEL+=("mailbox-aux:integration-mailbox-aux-orchestrator-e2e.sh")
fi
# Also skip the bundle + restore SCENARIOS inside the staging-all suite —
# they exercise the same snapshot path through the tenant-backup-v2
# bundle orchestrator. The existing SKIP_BUNDLE_SCENARIO=1 /
# SKIP_RESTORE_SCENARIO=1 env vars in integration-staging.sh gate them.
if [[ "${INTEGRATION_INCLUDE_SNAPSHOTS:-}" != "1" ]]; then
  export SKIP_BUNDLE_SCENARIO="${SKIP_BUNDLE_SCENARIO:-1}"
  export SKIP_RESTORE_SCENARIO="${SKIP_RESTORE_SCENARIO:-1}"
fi
# Operator opt-out: INTEGRATION_PARALLEL=0 forces serial execution
# (useful when debugging a flake — easier to read sequential logs).
INTEGRATION_PARALLEL="${INTEGRATION_PARALLEL:-1}"
# Also skip the bundle + restore SCENARIOS inside the staging-all suite —
# they exercise the same snapshot path through the tenant-backup-v2
# bundle orchestrator. The existing SKIP_BUNDLE_SCENARIO=1 /
# SKIP_RESTORE_SCENARIO=1 env vars in integration-staging.sh gate them.
if [[ "${INTEGRATION_INCLUDE_SNAPSHOTS:-}" != "1" ]]; then
  export SKIP_BUNDLE_SCENARIO="${SKIP_BUNDLE_SCENARIO:-1}"
  export SKIP_RESTORE_SCENARIO="${SKIP_RESTORE_SCENARIO:-1}"
fi

# ─── tiering + per-suite timeout metadata (P3) ───────────────────────
# Tier defaults to 'core'. 'slow' = the long poles (bias them out for a
# quick sweep); 'external' = needs confidential off-cluster targets (those
# suites also require_or_skip internally, so they self-skip when unconfigured).
declare -A SUITE_TIER=(
  [staging-all]=slow [postgres-pitr]=slow [system-snapshots]=slow
  [waf-failure]=slow [wal-archive-failure]=slow [db-dumps]=slow
  [backup-rclone-shim]=external [dr-drill-shim]=external
  # 2026-07-16 newly-wired manual suites
  [dr-tenant-restore]=slow [dr-database-restore]=slow [dr-recover-all]=slow
  [migration]=slow [postgres-barman-restore]=slow [custom-deployments]=slow
  [custom-deployments-phase2]=slow [private-worker]=slow [mailbox-aux]=slow
  [mail-external-reachability]=slow [master-user-rotation]=slow
  [mail-dr-failover]=slow [mail-dr-dataplane]=slow [mail-mobility]=slow
  [system-dr-drill]=slow [platform-domain-rename]=slow
  [tenant-bundles-restic]=external [dr-protocols]=external
  [bundle-coverage]=external [backups-ui]=external
)
# Per-suite hard-timeout overrides (seconds). Set comfortably ABOVE the
# expected max so the timeout catches HANGS, never a legitimately long run.
declare -A SUITE_TIMEOUT=(
  [staging-all]=3000 [postgres-pitr]=2400 [system-snapshots]=2400 [db-dumps]=2400
  # monitoring-slo's alert leg legitimately waits out cnpg-down's
  # forSeconds=300 twice (fire + resolve) plus evaluator ticks.
  [monitoring-slo]=1500
  # 2026-07-16 newly-wired manual suites (above expected max → catch HANGs)
  [dr-tenant-restore]=1800 [dr-database-restore]=1800 [dr-recover-all]=1800
  [migration]=1800 [postgres-barman-restore]=2400 [custom-deployments]=1500
  [custom-deployments-phase2]=1500 [private-worker]=1200 [mailbox-aux]=1200
  [tenant-bundles-restic]=1200 [bundle-coverage]=1200 [backups-ui]=600
  [mail-external-reachability]=1200 [master-user-rotation]=900
  [firewall-blacklist]=600 [dr-protocols]=900
  [mail-dr-failover]=2400 [mail-dr-dataplane]=2400 [mail-mobility]=1800
  [platform-domain-rename]=1800 [system-dr-drill]=3000
)
suite_tier_of()    { echo "${SUITE_TIER[$1]:-core}"; }
suite_timeout_of() { echo "${SUITE_TIMEOUT[$1]:-$DEFAULT_SUITE_TIMEOUT}"; }
_csv_has() { local IFS=','; local x; for x in $1; do [[ "$x" == "$2" ]] && return 0; done; return 1; }
suite_selected() {
  local name="$1" tier; tier="$(suite_tier_of "$name")"
  if [[ -n "$ONLY" ]]; then _csv_has "$ONLY" "$name"; return; fi
  if [[ -n "$EXCLUDE" ]] && _csv_has "$EXCLUDE" "$name"; then return 1; fi
  if [[ -n "$TIER_FILTER" && "$TIER_FILTER" != "smoke" ]]; then _csv_has "$TIER_FILTER" "$tier"; return; fi
  return 0
}
filter_group() { local -n _arr="$1"; local e; for e in "${_arr[@]:-}"; do [[ -z "$e" ]] && continue; suite_selected "${e%%:*}" && printf '%s\n' "$e"; done; }

# --tier smoke = ONLY the smoke gate, no suites.
if [[ "$TIER_FILTER" == "smoke" ]]; then
  SERIAL_PRE=(); PARALLEL=(); SERIAL_POST=(); RUN_SMOKE=1
else
  mapfile -t SERIAL_PRE  < <(filter_group SERIAL_PRE)
  mapfile -t PARALLEL    < <(filter_group PARALLEL)
  mapfile -t SERIAL_POST < <(filter_group SERIAL_POST)
fi

if [[ "$LIST" == 1 ]]; then
  printf 'Resolved selection (tier_filter=%s only=%s exclude=%s smoke_gate=%s):\n' \
    "${TIER_FILTER:-<all>}" "${ONLY:-<none>}" "${EXCLUDE:-<none>}" "$RUN_SMOKE"
  for grp in SERIAL_PRE PARALLEL SERIAL_POST; do
    declare -n _g="$grp"; printf '  [%s]\n' "$grp"
    for e in "${_g[@]:-}"; do [[ -z "$e" ]] && continue; n="${e%%:*}"; printf '    %-22s tier=%-8s timeout=%ss\n' "$n" "$(suite_tier_of "$n")" "$(suite_timeout_of "$n")"; done
  done
  exit 0
fi

passed_suites=()
failed_suites=()
skipped_suites=()
reachability_breaks=()
declare -A SUITE_SECS=()    # name → wall-clock seconds (P4 timing)
declare -A SUITE_RC=()      # name → exit code

# After every suite, assert the admin panel is still reachable. A
# suite that errors mid-flight and leaves protect_admin_via_proxy=true
# or otherwise mutates global state was previously silent — the
# remaining suites would all 401 with no signal, and the operator
# learned about it only when manually checking. 2026-05-16 operator
# audit: "Not even the admin panel is reachable, how could this be
# missed?"
ADMIN_HOST_FOR_PROBE="${ADMIN_HOST:-https://admin.staging.example.test}"
assert_admin_reachable() {
  local label="$1" code
  for _try in 1 2 3 4 5; do
    code=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 10 "${ADMIN_HOST_FOR_PROBE}/" 2>/dev/null || echo "000")
    [[ "$code" == "200" ]] && return 0
    sleep 3
  done
  reachability_breaks+=("$label (http=$code)")
  warn "admin panel UNREACHABLE after $label (http=$code) — global state may be corrupted"
  return 1
}

# Exit-code convention (autoconf SKIP = 77):
#   0   → suite ran AND every assertion passed
#   77  → suite intentionally skipped (precondition not met on this
#         cluster shape — e.g. HA-tier flip on single-node). Distinct
#         from a pass so the operator sees "this was not tested" rather
#         than "this works." Was silent-passing as 0 prior to 2026-05-16
#         and the user correctly called that out as a false positive.
#   *   → real failure
SKIP_RC=77

# run_serial_group GROUP_LABEL SUITE_ENTRY...
# Runs each suite sequentially; output streams live. Reachability
# probe between every suite catches global-state breakage.
run_serial_group() {
  local group_label="$1"; shift
  log "Group [$group_label] (serial, ${#@} suite(s))"
  for entry in "$@"; do
    local name="${entry%%:*}" cmd="${entry#*:}"
    # Split "script.sh arg1 arg2" into script + args ARRAY. read -a gives
    # parts[0]=script, parts[1..]=args (empty array for a no-arg entry —
    # passing "${args[@]}" then expands to zero words, NOT the script name).
    local -a parts=()
    read -r -a parts <<< "$cmd"
    local script="${parts[0]}"
    local args=("${parts[@]:1}")
    local to start; to="$(suite_timeout_of "$name")"; start=$(date +%s)
    log "Suite: $name (tier=$(suite_tier_of "$name"), hard-timeout ${to}s)"
    # #130 + 2026-07-09: FORCE a fresh, full-TTL token before EACH suite.
    # Must be force_mint, NOT mint_token: mint_token is cache-backed
    # (get_admin_token) and reuses the shared token while it's merely >120s from
    # expiry — so before a LONG suite it can hand back a near-dead token (as
    # little as ~2 min of life). staging-all runs ~12 min on a SINGLE token
    # (integration-staging.sh sets TOKEN once, never re-logs-in), so a near-dead
    # token expires mid-suite → early scenarios pass, `mail`/`hostname`/late ones
    # 401 with INVALID_TOKEN (root-caused 2026-07-09: the rc.18 staging-all
    # failure; only reproduces via the shared cache, never standalone). force_mint
    # ignores the cache → every suite starts with the full 30-min TTL. ~20 logins
    # across a full run is not a storm and force_mint has its own 429 backoff.
    INTEGRATION_TOKEN="$(force_mint)" && export INTEGRATION_TOKEN || warn "$name: token refresh failed (continuing with prior token)"
    set +e
    # Export the shared bearer as ADMIN_TOKEN too: suites that read ADMIN_TOKEN
    # directly (webmail-feature-toggle, bulwark-impersonate, node-terminal,
    # webmail-platform, …) otherwise silently SKIP their token-gated phases in
    # the full run — they don't consume the INTEGRATION_TOKEN cache.
    ADMIN_PASSWORD="$ADMIN_PASSWORD" ADMIN_TOKEN="${INTEGRATION_TOKEN:-}" TOKEN="${INTEGRATION_TOKEN:-}" timeout --kill-after=30s "${to}s" "$SCRIPT_DIR/$script" "${args[@]}"
    local rc=$?
    set -e
    SUITE_SECS["$name"]=$(( $(date +%s) - start )); SUITE_RC["$name"]=$rc
    classify_rc "$name" "$rc"
    assert_admin_reachable "$name" || true
  done
  # Restore the top-level default (the script runs `set -uo pipefail`, NOT
  # -e). The per-suite `set -e`/`set +e` dance above otherwise leaks -e to
  # the caller — a global option, not function-scoped — making every later
  # top-level bare assignment abort the run on the first command blip.
  set +e
}

# run_parallel_group GROUP_LABEL SUITE_ENTRY...
# Background-launches every suite, captures stdout+stderr to a per-
# suite log, then waits for all and replays each log in order
# (so the operator sees one coherent stream per suite rather than
# interleaved chaos). Failed suites' logs print FIRST so the failure
# is in plain view at the bottom of the operator's terminal scroll.
run_parallel_group() {
  local group_label="$1"; shift
  local n=$#
  log "Group [$group_label] (parallel, $n suite(s))"
  local tmpdir
  tmpdir=$(mktemp -d)
  local -a pids=() names=() rcfiles=() logfiles=()
  # Concurrency cap. Launching all ~20 suites at once thundering-herds a
  # small cluster: the heavy tenant/PVC/FM/Longhorn suites (tier-flip, grow,
  # pvc, burstable-qos) then miss their tail poll-timeouts (FM pod slow to
  # schedule, ResourceQuota/API pressure) and fail in the FULL run while
  # passing standalone. A rolling window keeps peak load bounded without
  # serialising the whole phase. Tune via INTEGRATION_MAX_PARALLEL (0/unset
  # → default 6; set high to restore the old launch-everything behaviour).
  # Default 4 (was 6): the full run now wires ~40 suites, many of which
  # PROVISION a tenant (namespace + quota + pods) or capture/restore bundles.
  # At 6 concurrent, that provisioning storm caused transient API 500s
  # (custom-deployments create) and pod-scheduling timeouts (drain warm-up) that
  # don't happen standalone. 4 keeps the storage-suite contention fixed too.
  # Tune with INTEGRATION_MAX_PARALLEL.
  local max_par="${INTEGRATION_MAX_PARALLEL:-4}"
  [[ "$max_par" =~ ^[0-9]+$ ]] && (( max_par >= 1 )) || max_par=4
  local running=0
  for entry in "$@"; do
    local name="${entry%%:*}" cmd="${entry#*:}"
    local logf="$tmpdir/$name.log" rcf="$tmpdir/$name.rc"
    # Split "script.sh arg1 arg2" into script + args ARRAY (see
    # run_serial_group for the no-arg rationale).
    local -a parts=()
    read -r -a parts <<< "$cmd"
    local script="${parts[0]}"
    local args=("${parts[@]:1}")
    local to; to="$(suite_timeout_of "$name")"
    (
      _s=$(date +%s)
      ADMIN_PASSWORD="$ADMIN_PASSWORD" ADMIN_TOKEN="${INTEGRATION_TOKEN:-}" TOKEN="${INTEGRATION_TOKEN:-}" timeout --kill-after=30s "${to}s" "$SCRIPT_DIR/$script" "${args[@]}" >"$logf" 2>&1
      _rc=$?
      echo "$_rc" > "$rcf"
      echo $(( $(date +%s) - _s )) > "$rcf.secs"
    ) &
    pids+=("$!")
    names+=("$name")
    rcfiles+=("$rcf")
    logfiles+=("$logf")
    log "  launched: $name (pid=$!)"
    # Throttle: once the window is full, block until one suite finishes
    # before launching the next. Peak concurrency stays at max_par.
    running=$((running + 1))
    if (( running >= max_par )); then
      wait -n 2>/dev/null || true
      running=$((running - 1))
    fi
  done
  log "  waiting for $n parallel suite(s) to finish…"
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  # Replay outputs: failures first, then passes (so the operator sees
  # the failure at the bottom of their scrollback).
  local i
  # Sort indices: failures first
  local -a order=()
  for i in "${!names[@]}"; do
    local rc; rc=$(cat "${rcfiles[$i]}" 2>/dev/null || echo 1)
    [[ $rc -ne 0 && $rc -ne $SKIP_RC ]] && order+=("$i")
  done
  for i in "${!names[@]}"; do
    local rc; rc=$(cat "${rcfiles[$i]}" 2>/dev/null || echo 1)
    [[ $rc -eq 0 || $rc -eq $SKIP_RC ]] && order+=("$i")
  done
  for i in "${order[@]}"; do
    local name="${names[$i]}" rc secs; rc=$(cat "${rcfiles[$i]}" 2>/dev/null || echo 1)
    secs=$(cat "${rcfiles[$i]}.secs" 2>/dev/null || echo 0)
    SUITE_SECS["$name"]=$secs; SUITE_RC["$name"]=$rc
    log "── output: $name (rc=$rc, ${secs}s) ──"
    cat "${logfiles[$i]}" 2>/dev/null || echo "  (no output captured)"
    classify_rc "$name" "$rc"
  done
  # One reachability probe per group (not per suite) — running it
  # between concurrent suites is meaningless. Run after they all
  # finish, with each suite's name attributed.
  for name in "${names[@]}"; do
    assert_admin_reachable "parallel:$name" || true
  done
  rm -rf "$tmpdir"
}

classify_rc() {
  local name="$1" rc="$2"
  if [[ $rc -eq 0 ]]; then
    pass "suite $name PASSED"
    passed_suites+=("$name")
  elif [[ $rc -eq $SKIP_RC ]]; then
    warn "suite $name SKIPPED (precondition not met on this cluster)"
    skipped_suites+=("$name")
  elif [[ $rc -eq 124 || $rc -eq 137 ]]; then
    fail "suite $name TIMED OUT (rc=$rc) — exceeded its hard timeout and was killed"
    failed_suites+=("$name")
  else
    fail "suite $name FAILED (rc=$rc)"
    failed_suites+=("$name")
  fi
}

# emit_report_json — machine-readable run report (P4). Suite names are
# slugs and rc/seconds are integers, so direct interpolation is JSON-safe.
emit_report_json() {
  local first=1 name
  printf '{\n  "startedTs": %s,\n  "durationSeconds": %s,\n' \
    "$RUN_STARTED_TS" "$(( $(date +%s) - RUN_STARTED_TS ))"
  printf '  "counts": {"passed": %d, "skipped": %d, "failed": %d},\n' \
    "${#passed_suites[@]}" "${#skipped_suites[@]}" "${#failed_suites[@]}"
  printf '  "suites": ['
  for name in "${!SUITE_RC[@]}"; do
    [[ $first == 1 ]] || printf ','; first=0
    printf '\n    {"name": "%s", "tier": "%s", "rc": %s, "seconds": %s}' \
      "$name" "$(suite_tier_of "$name")" "${SUITE_RC[$name]:-0}" "${SUITE_SECS[$name]:-0}"
  done
  printf '\n  ],\n  "reachabilityBreaks": %d\n}\n' "${#reachability_breaks[@]}"
}

# ─── Host-config converger preflight (2026-07-09) ─────────────────────
# Drive the platform-ops host-config converger on the control plane BEFORE any
# suite, so the cluster is at the DEPLOYED release's host state — most importantly
# the host-migrations (chart bumps etc.) that Flux does NOT apply (they reach a
# node only via the converger). Closes the gap where a suite validated a release
# whose host-migrations had never run on the cluster (e.g. rc.16: cert-manager/
# traefik/cnpg chart bumps were only Flux-half-applied on staging until this ran).
# Blocks until the converge COMPLETES (host-migrations 0 pending). Skips cleanly
# for local/DinD (no SSH_HOST) or INTEGRATION_SKIP_CONVERGE=1. Non-fatal by
# default (loud warn); INTEGRATION_REQUIRE_CONVERGE=1 makes a failure abort.
converge_host_config() {
  [[ "${INTEGRATION_SKIP_CONVERGE:-0}" == "1" ]] && { log "host-config converge SKIPPED (INTEGRATION_SKIP_CONVERGE=1)"; return 0; }
  { [[ -n "${SSH_HOST:-}" ]] && [[ -n "${KUBECTL:-}" ]]; } || { log "host-config converge SKIPPED (no SSH_HOST/KUBECTL — local/DinD run)"; return 0; }
  log "Host-config converge: apply the deployed release's host-migrations on the control plane"
  local remote_ssh=(ssh -i "${SSH_KEY:-$HOME/hosting-platform.key}" -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o LogLevel=ERROR "$SSH_HOST")

  # Resolve the version actually DEPLOYED (platform-api image tag) — not the
  # cluster platform-version CM (can read "unknown"). self-upgrade's releases
  # fallback targets STABLE only, so an RC binary must be requested by explicit
  # --version or the converger would embed the wrong release's migrations.
  local deployed
  deployed=$($KUBECTL -n platform get deploy platform-api -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | sed -E 's/.*:([^:]+)$/\1/')
  [[ -n "$deployed" ]] || { warn "host-config converge: could not resolve deployed platform-api version — skipping"; return 0; }
  log "  target release: ${deployed}"

  # 1) Ensure the control-plane binary embeds THIS release's migrations
  #    (no-op if already current; upgrades cosign-verified otherwise).
  "${remote_ssh[@]}" "platform-ops self-upgrade --version=${deployed}" 2>&1 \
    | grep -vE 'DeprecationWarning|trace-deprecation' | sed 's/^/    self-upgrade: /' || true

  # 2) Converge host state (sysctls/packages/host-migrations) in enforce mode,
  #    then assert the host-migrations line reports 0 pending.
  local out rc mig_line pending
  out=$("${remote_ssh[@]}" "platform-ops host-config apply --apply" 2>&1 | grep -vE 'DeprecationWarning|trace-deprecation'); rc=$?
  printf '%s\n' "$out" | grep -iE 'host-config (host-migrations|sysctls|packages|modules)' | sed 's/^/    /'
  mig_line=$(printf '%s\n' "$out" | grep -i 'host-config host-migrations' | tail -1)
  pending=$(printf '%s' "$mig_line" | sed -nE 's/.*, ([0-9]+) pending,.*/\1/p')
  if [[ "$rc" == "0" && ( -z "$pending" || "$pending" == "0" ) ]]; then
    pass "host-config converge complete — host-migrations 0 pending (${deployed})"
    return 0
  fi
  warn "host-config converge INCOMPLETE (rc=$rc pending=${pending:-?}) — cluster may not be at ${deployed} host state: ${mig_line}"
  if [[ "${INTEGRATION_REQUIRE_CONVERGE:-0}" == "1" ]]; then
    fail "host-config converge required (INTEGRATION_REQUIRE_CONVERGE=1) but did not complete — aborting"
    [[ -n "$REPORT_JSON" ]] && emit_report_json > "$REPORT_JSON"
    exit 1
  fi
}
converge_host_config

# ─── Cluster-state baseline gate (2026-07-10) ────────────────────────
# The suites share ONE long-lived cluster — and staging/production behave the
# SAME way: Flux rolls new images in place, nothing is wiped between runs. So a
# scenario that mutates shared state and fails to restore it poisons later
# scenarios AND the next run. That is the real mechanism behind "passes
# standalone, fails in the full run" — NOT randomness, NOT infra flake.
#
# This gate asserts the canonical baseline BEFORE the first suite. Per the
# operator decision (2026-07-10): report any drift LOUDLY (so drift arriving
# from a NON-test source — a genuine upgrade bug — is never silently masked),
# then self-heal reversible config so the run proceeds. Bypass: INTEGRATION_SKIP_BASELINE=1.
BASELINE_DRIFT_FOUND=0
assert_baseline_state() {
  [[ "${INTEGRATION_SKIP_BASELINE:-0}" == "1" ]] && { warn "baseline gate SKIPPED (INTEGRATION_SKIP_BASELINE=1)"; return 0; }
  log "Cluster-state baseline gate"
  # ADMIN_HOST is the harness-canonical base (defaulted at top of file); the
  # old ${DOMAIN} fallback was never set and crashed this gate under `set -u`
  # before any suite ran.
  local base="${PLATFORM_API_URL:-$ADMIN_HOST}" tok="${INTEGRATION_TOKEN:-}"
  [[ -n "$tok" ]] || tok=$(force_mint 2>/dev/null || true)
  if [[ -z "$tok" ]]; then warn "baseline gate: no admin token — cannot assert baseline (continuing)"; return 0; fi

  # (1) Webmail engine must be canonical. A prior run's engine flip that failed
  #     to restore leaks roundcube-scaled-to-0 into webmail-feature-toggle etc.
  local eng; eng=$(il_webmail_engine_get "$base" "$tok")
  if [[ -z "$eng" ]]; then
    warn "baseline: could not read default_webmail_engine (skipping engine check)"
  elif [[ "$eng" == "$IL_WEBMAIL_CANONICAL_ENGINE" ]]; then
    pass "baseline: webmail engine = $eng (canonical)"
  else
    BASELINE_DRIFT_FOUND=$((BASELINE_DRIFT_FOUND+1))
    warn "baseline DRIFT: webmail engine = '$eng' (expected '$IL_WEBMAIL_CANONICAL_ENGINE') — a prior run left it flipped; self-healing"
    if il_webmail_engine_set "$base" "$tok" "$IL_WEBMAIL_CANONICAL_ENGINE" 20; then
      pass "baseline: webmail engine reset → $IL_WEBMAIL_CANONICAL_ENGINE"
    else
      warn "baseline: engine reset PATCH failed — suites may inherit drift"
    fi
  fi

  (( BASELINE_DRIFT_FOUND > 0 )) \
    && warn "baseline gate: ${BASELINE_DRIFT_FOUND} drift item(s) found+healed — a prior run leaked state (see above)" \
    || pass "baseline gate: cluster is at canonical baseline (no drift)"
}
assert_baseline_state

# ─── Execute ──────────────────────────────────────────────────────
# Smoke gate (P3): a fast health check BEFORE the long suites — fail in
# seconds, not 40 minutes, if the platform is already broken. --no-smoke skips.
if [[ "$RUN_SMOKE" == 1 ]]; then
  log "Smoke gate: scripts/smoke-test.sh (abort on red; --no-smoke to skip)"
  smoke_rc=0
  ADMIN_PASSWORD="$ADMIN_PASSWORD" timeout --kill-after=15s 300s "$SCRIPT_DIR/smoke-test.sh" || smoke_rc=$?
  SUITE_SECS["smoke-gate"]=0; SUITE_RC["smoke-gate"]=$smoke_rc
  if [[ $smoke_rc -ne 0 && $smoke_rc -ne $SKIP_RC ]]; then
    fail "smoke gate FAILED (rc=$smoke_rc) — aborting before the suite. Re-run with --no-smoke to bypass."
    [[ -n "$REPORT_JSON" ]] && emit_report_json > "$REPORT_JSON"
    exit 1
  fi
fi

[[ ${#SERIAL_PRE[@]} -gt 0 ]] && run_serial_group "PRE (sequential, mutates global state)" "${SERIAL_PRE[@]}"

# Barrier: let the control plane SETTLE before launching the parallel batch.
# SERIAL_PRE (staging-all) toggles WAL-archive enable/disable on system-db, which
# patches the CNPG `system-db` spec.plugins[barman-cloud] → CNPG ROLLING-RESTARTS
# the primary → platform-api flaps with it (docker-entrypoint.sh says it outright:
# "every backup-target enable/disable" restarts the API). If that flap is still
# settling when the parallel batch launches, the API returns empty bodies that
# fail the parallel suites as COLLATERAL — root-caused 2026-06-26: 6-9 suites died
# on JSONDecodeError (empty body) with INVALID_TOKEN=0, no 429s; capping
# concurrency made it WORSE (it's a control-plane event, not load). Gate on a
# DB-BACKED endpoint (healthz is SHALLOW — returns 200 even while postgres is
# down) being stably 200 so the batch runs against a settled control plane.
wait_for_control_plane_stable() {
  local need=6 ok=0 i max=180 code   # 6 consecutive DB-backed 200s (~30s stable), up to 15 min
  log "Barrier: waiting for platform-api + DB to stabilize after SERIAL_PRE before the parallel batch…"
  for ((i=0; i<max; i++)); do
    # `|| echo 000`: a curl timeout exits 28; a BARE assignment under a
    # leaked `set -e` (run_serial_group leaves -e on — see set +e below)
    # would then abort the WHOLE run (exit 28) on a single transient
    # control-plane blip — the exact instability this barrier exists to
    # ABSORB. Keep the sub exit 0 so the loop treats a blip as a blip.
    code=$(curl -sk --max-time 6 -o /dev/null -w '%{http_code}' "$ADMIN_HOST/api/v1/plans" 2>/dev/null || echo 000)
    if [[ "$code" == "200" ]]; then
      ok=$((ok+1))
      if [[ $ok -ge $need ]]; then log "  control plane stable ($need consecutive DB-backed 200s)"; return 0; fi
    else
      if [[ $ok -gt 0 ]]; then log "  control-plane blip (HTTP ${code:-000}) — resetting stability counter"; fi
      ok=0
    fi
    sleep 5
  done
  warn "control plane not stable within $((max*5))s — proceeding anyway (parallel group may flake)"
  return 0
}
if [[ ${#SERIAL_PRE[@]} -gt 0 && ${#PARALLEL[@]} -gt 0 ]]; then
  wait_for_control_plane_stable
fi

# FORCE a fresh, full-TTL token before the parallel batch. Group PRE can run
# 10-20 min, and the parallel batch runs concurrently for another 20-30 min
# during which suites CANNOT be re-tokened one-by-one (they run at once). A
# plain mint_token here reuses the cache while it's >120s from expiry, so the
# parallel group would inherit a near-dead token and die mid-flight (the
# INVALID_TOKEN cascade observed 2026-06-25). force_mint guarantees a full TTL.
log "Force-minting a fresh INTEGRATION_TOKEN before the parallel group"
INTEGRATION_TOKEN="$(force_mint)"
[[ -n "$INTEGRATION_TOKEN" ]] || { fail "mid-run re-login failed — aborting"; exit 1; }
export INTEGRATION_TOKEN

# Background refresher: while the parallel group runs, keep the SHARED cache
# file fresh by force-re-minting every ~12 min. Suites whose API wrapper fetches
# get_admin_token per request (waf-crowdsec, firewall, …) thus never see an
# expired token even on a 30-min+ run. Killed via trap on exit.
_token_refresher() {
  while true; do
    sleep 720
    force_mint >/dev/null 2>&1 || true
  done
}
_REFRESHER_PID=""
if [[ ${#PARALLEL[@]} -gt 0 && "$INTEGRATION_PARALLEL" == "1" ]]; then
  _token_refresher & _REFRESHER_PID=$!
  trap '[[ -n "$_REFRESHER_PID" ]] && kill "$_REFRESHER_PID" 2>/dev/null || true' EXIT
fi

if [[ ${#PARALLEL[@]} -gt 0 ]]; then
  if [[ "$INTEGRATION_PARALLEL" == "1" ]]; then
    run_parallel_group "PARALLEL (independent tenants)" "${PARALLEL[@]}"
  else
    warn "INTEGRATION_PARALLEL=0 — running parallel group sequentially"
    run_serial_group "PARALLEL→serial (override)" "${PARALLEL[@]}"
  fi
fi

# Stop the refresher before the (serial) post group — serial suites re-token
# per-suite, so the background loop is no longer needed.
if [[ -n "$_REFRESHER_PID" ]]; then kill "$_REFRESHER_PID" 2>/dev/null || true; _REFRESHER_PID=""; fi

# Final force-mint + serial post-group.
if [[ ${#SERIAL_POST[@]} -gt 0 ]]; then
  INTEGRATION_TOKEN="$(force_mint)" && export INTEGRATION_TOKEN || warn "post-group re-login failed"
  run_serial_group "POST (destructive, terminal)" "${SERIAL_POST[@]}"
fi

log "Final results"
printf '  %bpassed:%b  %s\n' "$GREEN" "$RESET" "${#passed_suites[@]}"
printf '  %bskipped:%b %s  (precondition not met — NOT validated)\n' "$YELLOW" "$RESET" "${#skipped_suites[@]}"
printf '  %bfailed:%b  %s\n' "$RED" "$RESET" "${#failed_suites[@]}"
for s in "${passed_suites[@]}";  do printf '    %b✓%b %s\n'  "$GREEN"  "$RESET" "$s"; done
for s in "${skipped_suites[@]}"; do printf '    %b⊝%b %s\n'  "$YELLOW" "$RESET" "$s"; done
for s in "${failed_suites[@]}";  do printf '    %b✗%b %s\n'  "$RED"    "$RESET" "$s"; done

# Per-suite wall time (P4) — surface the long poles for future tiering.
if [[ ${#SUITE_SECS[@]} -gt 0 ]]; then
  log "Per-suite wall time (slowest first)"
  for name in "${!SUITE_SECS[@]}"; do printf '%s\t%s\n' "${SUITE_SECS[$name]}" "$name"; done \
    | sort -rn | awk -v g="$CYAN" -v x="$RESET" '{printf "    %s%5ds%s  %s\n", g, $1, x, $2}'
  printf '  %btotal wall:%b %ss\n' "$CYAN" "$RESET" "$(( $(date +%s) - RUN_STARTED_TS ))"
fi

if [[ ${#reachability_breaks[@]} -gt 0 ]]; then
  fail "admin panel was unreachable after ${#reachability_breaks[@]} suite(s):"
  for b in "${reachability_breaks[@]}"; do printf '    %b⚠%b %s\n' "$RED" "$RESET" "$b"; done
  echo ""
  echo "  A suite left global state in a broken condition (proxy gate enabled with no provider,"
  echo "  Flux suspended, ingress misconfigured, etc.). Look at the named suite's EXIT trap."
  echo ""
fi

# Always-run cleanup pass — drops any test clients that escaped the
# per-suite EXIT traps (mid-suite SIGKILL, Ctrl+C between suites,
# scripts that don't yet wire trap-cleanup correctly). Uses the
# official lifecycle DELETE so cascade hooks fire (DNS / backups /
# secrets / namespace / PV reclaim / Longhorn volume delete) — the
# same path production operators use.
log "Post-suite cleanup pass (deletes leftover test clients via lifecycle API)"
yes y | ADMIN_PASSWORD="$ADMIN_PASSWORD" "$SCRIPT_DIR/integration-cleanup.sh" 2>&1 \
  | tail -20 || warn "integration-cleanup.sh reported errors — re-run manually if leaks persist"

# Hard CI guard — fail the run if any test-tenant namespace OR Released
# test-pattern PV survived the per-suite traps AND the cleanup pass
# above. The cleanup pass uses the lifecycle API, which fails when
# system-db is down (the chicken-and-egg scenario observed on
# testing.example.test 2026-05-17). This guard talks directly to
# the apiserver so it catches that case. CI_LEAK_GUARD=0 disables.
log "Leak guard (assert no test-tenant namespaces, Released test-PVs, or orphaned Longhorn volume CRs survived)"
leak_rc=0
"$SCRIPT_DIR/ci-no-leaked-test-tenants.sh" || leak_rc=$?
if [[ $leak_rc -eq 1 ]]; then
  fail "leak guard FAILED — see above. Set CI_LEAK_GUARD=0 to override (use sparingly)."
  failed_suites+=("leak-guard")
elif [[ $leak_rc -eq 2 ]]; then
  warn "leak guard could not run (no cluster access) — re-check manually"
fi

# Machine-readable run report (P4) — for the morning report / CI dashboards.
if [[ -n "$REPORT_JSON" ]]; then
  emit_report_json > "$REPORT_JSON" && log "JSON report → $REPORT_JSON"
fi

# Real failures + reachability breaks both fatal.
[[ ${#failed_suites[@]} -eq 0 && ${#reachability_breaks[@]} -eq 0 ]] || exit 1
