# Platform Roadmap — Open Follow-Ups

> **This file is the single tracking register for planned-but-unbuilt work**
> (decision 2026-06-07: no GitHub issues are pre-created; open one when an item
> actually starts and link it here).
>
> Descoped on 2026-06-07 (will NOT be built — do not re-add without operator
> decision): PHP Composer support · AI no-code website editor · bespoke
> web-server/PHP switching wizard (capability ships via the workload catalog) ·
> per-message email delivery tracking (`email_messages`) · multi-region /
> geographic sharding / co-hosting.

| # | Item | Priority | Status |
|---|------|----------|--------|
| [R1](#r1--plesk-migration-service) | Plesk migration service | **P1** | Shipped (PRs #70–#89) — E2E on staging; production cutover pending |
| [R2](#r2--monitoring-stack-decision--slislo) | Monitoring stack decision + SLI/SLO | **P1** | Shipped (ADR-051, PRs #50–#63) — logs deferred |
| [R3](#r3--load-testing-in-ci) | Load testing in CI | P2 | Framework exists, unwired |
| [R4](#r4--fbl-complaint-processing) | FBL complaint processing | **P1** (for production mail) | Shipped (PRs #64–#69) |
| [R5](#r5--dmarc-aggregate-report-ingestion) | DMARC aggregate-report ingestion | P2 | Not started |
| [R6](#r6--rolling-sending-quota-enforcement) | Rolling sending-quota enforcement | P2 | Shipped (PRs #64–#69) |
| [R7](#r7--ip-warm-up-pools-and-per-domain-relay) | IP warm-up, pools, per-domain relay | P3 | Not started |
| [R8](#r8--notification-channels-slack--webhook--sms) | Notification channels: Slack/Webhook/SMS | P3 | Email + in-app shipped |
| [R9](#r9--staff-role-email-access) | Staff-role email access | P3 | Not started |
| [R10](#r10--bulwark-deferred-work) | Bulwark deferred work (phases 7–8) | P3 | Deferred by decision |
| [R11](#r11--security-hardening-phase-2) | Security-hardening Phase 2 (+ Trivy revisit) | P2 | Shipped — K8s posture + auth tabs + NetworkPolicy bulk-apply + operator→trusted-range bridge (2026-06-18); only Trivy (deferred) open |
| [R12](#r12--service-to-service-mtls) | Service-to-service mTLS | P3 | NetworkPolicy-only today |
| [R13](#r13--ipv6-completion) | IPv6 completion | P3 | Dual-stack firewall + DNS AAAA only |
| [R14](#r14--user-manual-website) | User-manual website | P2 | Shipped — live at insulahq.github.io |
| [R15](#r15--component-cve--version-watch) | Component CVE & version watch | P2 | Shipped (ADR-050) — ongoing operation |
| [R16](#r16--decouple-ingress_domain-from-platform_domain--turnkey-apex-rename) | Decouple ingress/platform domain + apex rename | P2 | Shipped (2026-06-13/14) — §3e DNS automation + live per-worker tunnel subdomains residual |
| [R17](#r17--mail-housekeeping-follow-ups-2026-06-10-single-node-green-up) | Mail/snapshot housekeeping follow-ups | P2 | Shipped (PRs #22–#39) — all three follow-ups done incl. Released-PV operator surface |
| [R18](#r18--operator-script-consolidation-into-the-platform-ops-cli) | Operator-script consolidation → platform-ops CLI | P2 | Shipped (T1–T4 + R18-finish) — released v2026.6.10 |
| [R19](#r19--tenant-on-server-snapshots--storage-resize-hardening) | Tenant on-server snapshots + storage-resize hardening | P2 | ✅ Shipped — snapshots + in-place/retained-volume restore + destructive-shrink quiesce + force-cancel restore all done (2026-06-17/18) |
| [R20](#r20--cross-cluster-tenant-migration) | Cross-cluster tenant migration | P3 | Design captured, not built |

---

## R1 — Plesk migration service

The original mission gate ("first Plesk customer migrated", Phase-1 Week 12):
extract domains, sites, databases, mailboxes, cron jobs, and DNS from a Plesk
server and import them as platform tenants. (The unrelated `tenant-migration`
module is worker re-pinning.)

**Shipped 2026-06-13 (ADR-052, PRs #70–#89), E2E-proven on staging against a
real Plesk Obsidian source.** An agentless `plesk-migration` module:
- **Source registry + agentless discovery** (#70–#72, #87–#88) — SSH (keyfile
  *or* password, `ssh-auth.ts`) into a Plesk box, parse its inventory; discovery
  now fails *visibly* with a classified reason (auth / unreachable / not-Plesk).
- **Provision a discovered subscription** (#73–#76) — tenant-first mapping onto a
  new **or existing, sized** tenant + capacity preflight; accepts `provisioned`
  (not only `active`) targets.
- **DB leg** (#77–#78, #80) — import Plesk databases into a per-tenant MariaDB
  (dedicated `migration-tools` image).
- **Content leg** (#79–#81) — rsync docroots onto `apache-php`; exit 23/24
  treated as success; PVC sized to the real docroot (the rsync-exit-11/ENOSPC
  root cause, #89).
- **Mail leg** (#82, #84–#85) — IMAP MULTIAPPEND import; `new/`→`cur/` reshape
  preserves unread state; preflight no longer double-counts on retry.
- **Cron leg** (#83) — Plesk scheduled tasks → platform cron jobs.
- **DNS** (#89) — Plesk primary-DNS domains migrate as PRIMARY; tenant DNS-records
  tab visible in CNAME mode.

Acceptance (one real subscription end-to-end: site serves, mail flows incl.
unread state, DB intact, cron firing) is **met on staging**; the remaining gate
is the production cutover. **Runbook:**
[PLESK_MIGRATION.md](../operations/PLESK_MIGRATION.md). Cron extraction details:
[CUSTOMER_CRON_JOBS.md](../features/CUSTOMER_CRON_JOBS.md).

## R2 — Monitoring stack decision + SLI/SLO

**Shipped 2026-06-12** (ADR-051, PRs #50–#61): VictoriaMetrics single-node
(`vmsingle`, one pod, 128Mi requests, 30-day retention) scrapes the
pre-existing exporter endpoints, and a 14-rule SLO evaluator runs inside
platform-api — zero dedicated alerting pods. Alerts dispatch through the
categorised notification sources (`admin.slo_alert_*`); VMUI and the Longhorn
UI are served from admin-host path routes (`/metrics/`, `/longhorn/`). The
legacy `--with-monitoring` kube-prometheus/Loki path is removed (the flags
are deprecation no-ops).

- As-built decision record:
  [ADR-051](../architecture/adr/ADR-051-monitoring-stack-vmsingle.md); rule
  pack in `backend/src/modules/monitoring/rules.ts` (tweak/disable via
  `monitoring_rule_overrides`).
- Original planning targets: [SLI_SLO_DEFINITION.md](SLI_SLO_DEFINITION.md) —
  where it disagrees with the shipped rule pack, ADR-051 is authoritative.
- E2E: `scripts/integration-monitoring-slo.sh` (registered in
  `integration-all.sh`).
- Deferred: log aggregation (decide separately if a need emerges).
- 2026-06-12 live exercise of the Flux-failure rule found it could never
  fire: Flux records failures in status conditions and requeues, so
  `controller_runtime_reconcile_errors_total` stays 0 through real failures
  (82 retries moved it by exactly 0). Replaced by the platform-side
  `platform_flux_unready_resources` gauge (Ready=False count from the kube
  API, suspended excluded).

## R3 — Load testing in CI

`scripts/benchmark/api-load-test.js` (k6) + `run-benchmark.sh` exist but run
nowhere. Wire into CI (manual-dispatch or nightly), capture baselines, enforce
the documented p95 < 500 ms target on core endpoints.

## R4 — FBL complaint processing

**Shipped 2026-06-12** (PRs #64–#69): feedback-loop ingestion via Stalwart
webhooks + `x:ArfExternalReport` / `report.analysis` — a `fbl@<apex>` SYSTEM
mailbox + JMAP poller writing `email_fbl_complaints` (per-domain complaint
rates over the send counters), complaint-rate thresholds (warning/critical),
and notify/auto enforcement (one-click or automatic throttle + outbound-mail
suspension), all surfaced in the Monitoring → Mail tab. The `email_messages`
per-message table stayed descoped. Auto-suspension closed loop proven live.
Runbook: [MAIL_FBL.md](../operations/MAIL_FBL.md).

## R5 — DMARC aggregate-report ingestion

Parse aggregate reports (Gmail/Outlook/Yahoo), compute per-domain pass rates,
surface in the email UI, and recommend policy tightening (p=none →
quarantine → reject) once pass-rate thresholds hold.

- Spec: the original email-deliverability spec (DMARC sections; see the git history).

## R6 — Rolling sending-quota enforcement

**Shipped 2026-06-12** (PRs #64–#69): per-tenant plan-based hourly/daily send
limits enforced through the Stalwart JMAP registry (`x:MtaOutboundThrottle`
hourly+daily keyed by sender domain + `x:MtaQueueQuota`, applied with a
`ReloadSettings` action; suspension forces a byte-quota block), with rolling
per-hour send accounting (`email_send_counters` fed by send webhooks), 80/100%
usage notifications + a usage UI, and a Sending-Protection control
(off / notify / auto). Replaced the dead static `[queue.throttle]` TOML that
Stalwart 0.16 never read. Plan/tenant limit model + the per-plan **max mailbox
size** cap land in the hosting-plan settings.

## R7 — IP warm-up, pools, and per-domain relay

IP warm-up schedule tracking, tiered IP pools, and per-domain external relay
(SendGrid/Mailgun transport maps) for tenants with deliverability needs.

- Spec: the original email-deliverability spec (see the git history).

## R8 — Notification channels: Slack / Webhook / SMS

The notification system (sources × providers × templates, pg-boss queue,
preferences, rate limiting, retention) is shipped with `email`,
`email-stalwart-master`, and `in-app` channels. Add Slack, generic webhook
(HMAC-signed), and SMS/Telegram as demand surfaces.

- Spec: the original notification roadmap (phases 4–6; phases 1–3 are
  delivered) — see the git history.

## R9 — Staff-role email access

Role-scoped admin access to tenant mailboxes with approval workflows and
audit (`staff_roles` / approval-request model). Distinct from the shipped
master-user impersonation, which is all-or-nothing super-admin.

- Spec: the original webmail-access spec ("Admin Email Access & Staff Role
  Management" sections) — see the git history.

## R10 — Bulwark deferred work

Phases 7–8 from the Bulwark epic, deferred by decision until after the v1
soak: per-user UI-settings backup/GDPR export, and settings purge on tenant
archive. Full context: [roadmap/BULWARK_DEFERRED_WORK.md](BULWARK_DEFERRED_WORK.md) (moved here).

## R11 — Security-hardening Phase 2

Phase-2 surface from the hardening epic, on the Security → Posture page:

- **K8s posture tab** — shipped (Phase 2.1): per-namespace PodSecurity levels +
  privileged / hostPath / hostNetwork pods.
- **Auth/audit metrics tab** — shipped (Authentication tab).
- **NetworkPolicy templates + bulk apply** — **shipped 2026-06-18** (Phase 2.4.1).
  Three egress templates (isolate-tenant / deny-all-egress / allow-dns-only) with
  a single managed policy per namespace, dry-run preview → confirm → apply, a
  reversible remove, opt-out + custom-egress + SYSTEM-tenant auto-skips. Calico
  enforcement live-proven (deny-all-egress blocks nslookup; remove restores it).
  See [SECURITY_HARDENING.md](../operations/SECURITY_HARDENING.md#networkpolicy-hardening-templates-network-policies-tab).

- **Operator → trusted-range bridge (lockout prevention)** — **shipped 2026-06-18.**
  The Firewall Posture tab warns when *your current connection's* IP isn't in a
  trusted range (the #1 lockout risk before an SSH/L4 lockdown) and offers a
  one-click "add my IP" (/32 or /128). IP derived server-side from X-Real-IP only
  (never the body); CIDR host-scoped; super_admin + Bearer-only. TDD (16 tests) +
  security/code review + live E2E + browser.

- **Denied source-IP → trusted-range bridge (the original P2.3.1)** —
  **superseded; intentionally NOT built (2026-06-18).** The firewall drops
  untrusted connections with `counter drop` (no source IPs logged), and the probe
  reads `/proc/net/nf_conntrack` (accepted flows only) — so surfacing the actual
  denied source IPs would require continuous `nflog` drop-logging on
  internet-facing nodes (scanner/bot noise) plus a sensitive nft-ruleset change.
  Not minimal-cost. The *value* — see who's being denied + allow a wrongly-blocked
  IP — is already delivered by **CrowdSec decisions + allowlists on Web Defense**;
  the Firewall Posture tab now cross-links there (`DeniedSourcesCrossLink`).

**Open:**
- **Trivy CVE scanning** — deferred until operator demand surfaces. (Only
  remaining R11 item.)

## R12 — Service-to-service mTLS

In-cluster platform-service traffic is NetworkPolicy-segmented but
unencrypted. Evaluate mTLS (mesh or per-service certs) per
`SECURITY_ARCHITECTURE.md` Phase-2 notes.

## R13 — IPv6 completion

Firewall and DNS are dual-stack; k3s cluster networking is IPv4-only.
Requirements doc: [roadmap/IPV4_IPV6_REQUIREMENTS.md](IPV4_IPV6_REQUIREMENTS.md) (moved here).

## R14 — User-manual website

Build the operator/tenant/admin manual website from `docs/architecture/`,
`docs/operations/`, and `docs/features/`, mining the requirement specs in the
git history where useful.

**Plan locked 2026-06-07** — see [USER_MANUAL_WEBSITE.md](USER_MANUAL_WEBSITE.md):
monorepo `documentation/`, Material for MkDocs now (Zensical-compatible authoring,
migrate post-alpha), GitHub Pages at `insulahq.github.io/insula`, v1 = all
three guides, accuracy via manual-impact CI guard + generated reference +
strict builds + freshness stamps.

**Shipped 2026-06-07** — live at <https://insulahq.github.io/> (moved to the
org root rather than `/insula`). Source lives in monorepo `documentation/`;
the separate `insulahq.github.io` repo pulls and publishes it on a 15-minute
schedule. Residual: the manual-impact CI guard runs report-only until
~2026-06-21, then flips to enforcing.

## R15 — Component CVE & version watch

Shipped 2026-06-08 (ADR-050) — listed here as an **ongoing operation**, not
open work. A tiered, machine-checkable watch over the ~65 components Insula
deploys: `security/components.yaml` (registry) + `security/cve-ledger.yaml`
(triage + waiver register), enforced by `scripts/ci-component-watch-check.sh`
(schema/drift/coverage/SLA), with a weekly OSV/upstream sweep, Dependabot, and
per-image Trivy. Operate it via [COMPONENT_WATCH.md](../operations/COMPONENT_WATCH.md).

Open follow-ups carried by the registry's "known hygiene items": pin Flux to a
release; align the `pg_dump` client image to PG 18; consolidate the duplicate
`alpine/k8s` + `busybox` tags; drop the legacy `roundcube:latest-fpm` reference.
The in-cluster Trivy scanning UI stays deferred under [R11](#r11--security-hardening-phase-2).

## R16 — Decouple INGRESS_DOMAIN from PLATFORM_DOMAIN + turnkey apex rename

**PR-1 + PR-2 + PR-3 shipped 2026-06-13/14, E2E-proven on testing** (renamed
the apex and back: panels + LE certs followed, served with a trusted cert,
`ingress_base_domain` stayed put): `platform_domain` split (migration 0066) +
`getPlatformApex()`, apex consumers repointed, a `POST
/admin/platform-domain/rename` action + **rename UI** that moves the
reconciler-driven surfaces, and (3rd pass, 2026-06-14, E2E 15/15) the
static-`${DOMAIN}` **stalwart web-admin UI + private-worker tunnel anchor** now
follow the rename via **seed-then-disown** (`reconcile: disabled` + platform-api
owns the Host/cert; shared `traefik-host-reconcile.ts`).
**Remaining:** platform-apex DNS automation (§3e), the **live per-worker tunnel
subdomains** (env-driven, disruptive to flip), and the cross-cutting
bootstrap/script/integration items. **Runbook:**
[PLATFORM_DOMAIN_RENAME.md](../operations/PLATFORM_DOMAIN_RENAME.md).

Scoped 2026-06-08 (planning) — see
[INGRESS_PLATFORM_DOMAIN_DECOUPLE.md](INGRESS_PLATFORM_DOMAIN_DECOUPLE.md). Split
the overloaded `ingress_base_domain` (today *both* the tenant CNAME-target *and*
the platform apex) into a new `platform_domain` (apex/brand) + the existing
`ingress_base_domain` (CNAME target), defaulting equal for a zero-change upgrade.
Then make every platform-owned hostname + TLS cert + DNS record follow
`platform_domain` so an apex rename is a single turnkey action (removing the
static `${DOMAIN}` dependency for renameable surfaces). Phasing: PR-1 settings
split (no behaviour change) → PR-2 repoint consumers → PR-3 (3a–3g) full turnkey
rename. Key design risk: GitOps-owned `${DOMAIN}` vs a runtime rename (doc §5).

## R17 — Mail housekeeping follow-ups (2026-06-10 single-node green-up)

Three small items deferred from the 2026-06-10 integration green-up
(PRs #22–#28 + the Stalwart orphan-cleanup PR):

1. **Snapshot-schedule true ownership split — SHIPPED 2026-06-11**
   (firing-mode split): `spec.schedule` is now FULLY Flux-owned and
   platform-api never patches it. An operator cadence equal to the
   manifest default runs via k8s cron (NATIVE mode; suspend follows the
   backup-target gate as before). A custom cadence flips the reconciler
   into PLATFORM mode: the CronJob is force-suspended (pure Job-template
   holder) and platform-api's firing engine creates Jobs on the
   operator's cron — ±5-min catch-up window, replica-safe claim via a
   conditional `backup_schedules.last_fired_at` update, plus
   deterministic per-minute Job names
   (`stalwart-snapshot-cron-<YYYYMMDDHHmm>`) with 409-tolerant create as
   the second dedup layer (mirrors the tenant-bundle global scheduler's
   convention). The SSA tug-of-war (PRs #28/#34 lineage) is gone; zero
   revert window.

2. **Rename-away cert-anchor cleanup — SHIPPED 2026-06-11** (PRs #36 +
   #37, validated E2E on testing: 7 real orphans detected, canonical
   anchor excluded, operator-confirmed delete-orphan removed all 7,
   Stalwart left with only the canonical row). principals-sync step 4b
   raises `kind=orphan-domain` drift items;
   `POST /admin/mail/drift/:id/delete-orphan` destroys DKIM + Domain
   with type-to-confirm, refusing domains that still carry member
   principals (`ORPHAN_HAS_PRINCIPALS` — the PITR-false-orphan guard).
   Tenant/domain-delete leaks were already fixed deterministically
   (destroyStalwartArtifactsForEmailDomain, #29).

3. **PITR Released-PV accumulation — BLOCKS the next PITR on small
   nodes (severity upgraded 2026-06-11).** Every postgres-pitr
   auto-promote leaves the previous `system-db` PV `Released` with
   `reclaimPolicy=Retain` (deliberate safety net — excluded from the
   Released-PV janitor by design), and its replica keeps pinning 20 Gi
   of Longhorn *scheduling budget*. Reproduced live on testing: with
   one prior Retained copy on a 75 GB node, the next PITR's
   recovery volume could not schedule a replica ("insufficient
   storage" precheck), the snapshot-recovery pod stuck at
   Init/FailedAttachVolume, and the orchestration stalled with
   system-db down. Recovery lever: temporarily raise Longhorn
   `storage-over-provisioning-percentage` (100→200) → volume attaches
   and CNPG + recoverInterruptedRestore self-heal end-to-end — then
   delete the superseded Released PVs (PV object + volumes.longhorn.io
   CR) and revert the setting. Fix needs BOTH an operator-facing
   surface (storage page badge + delete action after a verified
   restore) AND a PITR preflight that checks Longhorn schedulable
   budget ≥ the recovery volume size, failing fast with an actionable
   error instead of stalling mid-cutover.
   **SHIPPED in full.** Preflight half (PR #35): `preflight-longhorn-budget`
   step + `PITR_INSUFFICIENT_STORAGE_BUDGET` names the reclaimable PVs + the
   over-provisioning lever; the integration harness also reclaims superseded
   Released PVs after each VERIFIED round-trip (PR #33). Operator surface
   (PR #39, `postgres-restore/released-pvs.ts` + `released-pvs.test.ts`):
   `GET /admin/postgres-restore/released-pvs` lists superseded
   `platform/system-db-*` Released PVs and
   `POST …/released-pvs/:name/reclaim` deletes BOTH the PV and its
   `volumes.longhorn.io` CR behind a strict re-verified filter + type-to-confirm
   (`CONFIRM_NAME_MISMATCH` / `PV_NOT_FOUND` / `PV_NOT_RECLAIMABLE`). UI:
   `ReleasedSystemPvsCard` on the System Backups page (Snapshots tab); the
   broader orphaned-volumes manager on the Storage page also catches Released
   PVs past the stale threshold.

## R18 — Operator-script consolidation into the `platform-ops` CLI

**Shipped 2026-06-14/15 (released v2026.6.10)** — plan + scope in
[PLATFORM_OPS_CLI_CONSOLIDATION.md](PLATFORM_OPS_CLI_CONSOLIDATION.md). All four
tranches landed: **T1** `admin reset-password` + `domain rename` (in-pod, the
native-dep graph isn't SEA-safe), **T2** `dr restore-component <etcd|mail|postgres>`
via embedded bash + the keep-vs-retire decisions, **T3** housekeeping
(`cluster gc-namespaces|upgrade-cnpg`, `component-watch`, `node-terminal gc`,
`backup rotate-key`), **T4** one-shot archival. The **R18-finish** convenience
batch added `cluster doctor`, `backup target` CRUD + bindings, `backup
key-status`, `mail rotate-master-password`, and folded on-node firewall posture
into `cluster diagnostics`; the E2E harness
(`integration-platform-ops-cli-e2e.sh`) is wired into `integration-staging.sh`.
Two enablers shipped alongside: **host-migrations default to `enforce`** + rclone
as a host dep (v2026.6.9), and a **scoped worker kubeconfig** so host-config runs
on worker nodes. **Residual:** the `ci-operator-script-placement` guard is
deferred; secrets fetch/restore deliberately stay `make` (workstation→remote
context); `mail rotate-admin-password` (the richer Stalwart admin rotation) stays
UI for now. Original scope below.

`scripts/` has ~177 shell scripts; ~25 are genuine on-node operator actions
(`admin-password-reset.sh`, `backup-target-key-rotate.sh`, the R16
`platform-domain rename` which is still API-only, …) that each re-implement
cluster plumbing (CNPG-primary resolution, bcrypt-in-pod, kubeconfig) in bash —
where bugs live (the password-reset script's multi-container `kubectl exec` +
leading-space quirks). ADR-045 already established the target: `platform-ops`
subcommands that **import the backend `modules/` directly** (one tested code
path), with DR already absorbed. This item finishes the migration **and draws the
keep-as-bash line**: bootstrap (installs the CLI — chicken/egg), CI guards,
test/integration harnesses, and deliberately dependency-light **break-glass**
fallbacks stay bash. Tranches: T1 `admin reset-password` + `domain rename` (prove
the pattern, both already have service modules) → T2 DR/secrets fold-in + retire
the already-superseded `dr-restore.sh`/`make diagnose` → T3 housekeeping actions →
T4 archive one-shot migrations. Adds an always-run `ci-operator-script-placement`
guard so new operator actions land as subcommands, not new bash. Open decisions:
secrets-fetch/restore (workstation→remote context) and delete-vs-archive for
one-shots — both in the plan doc §7.

## R19 — Tenant on-server snapshots + storage-resize hardening

**Mostly shipped 2026-06-14/15 (PRs #90–#102)** — on-server tenant volume
snapshots via Longhorn CSI (`tenant-panel` Snapshots page: list / create / delete,
48h reaper + admin expiry), and **full-volume restore via in-place Longhorn
`snapshotRevert`** (shared `storage-lifecycle/longhorn-revert.ts`:
maintenance-attach → revert → no PVC delete; the dataSource-clone approach was
abandoned — it stalled `copy-completed-awaiting-healthy` while detached).
Destructive PVC **shrink** was hardened across a 5-bug chain (#90–#95): quiesce
only waits on pods mounting the target PVC; quiesce actually scales workloads to
0; pre-resize snapshot → files-only restic bundle through a per-class S3
streaming store (PodSecurity-safe); tenant namespaces labelled so backup/snapshot
Jobs reach the rclone shim. **Runbook:**
[TENANT_SNAPSHOTS.md](../operations/TENANT_SNAPSHOTS.md).

**Per-file restore shipped 2026-06-16 (#105)** — but via the off-site **bundle
restore cart**, not the on-server snapshot: a lazy restic file-tree browse
(`…/bundles/:id/browse/files/tree`) + a `files-paths` cart item that restores
selected paths (idempotent overwrite, pre-restore snapshot taken). See
[TENANT_BACKUP.md](../operations/TENANT_BACKUP.md). On-server Longhorn snapshots
remain whole-volume revert by design.

**rclone-shim multipart > 1 GB — no longer reached (2026-06-16, #118).** The
original failure was a single `tar | gzip | rclone rcat` object OOMing the shim's
gofakes3 `serve s3` at `CompleteMultipartUpload` (`NoSuchUpload` ~chunk 68).
**Every tenant-data path that produced that object now goes through restic** (64
MiB chunked packs — many small PUTs, never one large object): pre-resize /
pre-archive bundles (`storage-lifecycle/prebundle.ts`, `service.ts`) and tenant
bundles (files + mail, `restic backup --stdin`). The legacy single-object
upload/restore methods (`streaming-store.ts:getStreamingJob` /
`getStreamingRestoreJob`) have **no live caller** since #118 deleted
`snapshot.ts`/`restore.ts`, and the `POST /storage/snapshot` repro endpoint was
removed in the same PR. The shim's multipart limit is now an *unreached* engine
property rather than an active blocker; large-PVC shrink/backup is no longer
gated on it. (System backups are unaffected: CNPG/barman uploads bounded 16 MiB
multipart parts — its earlier `NoSuchUpload` was a sidecar OOM, fixed 2026-05-20
via a 1Gi memory bump — and etcd snapshots are small single files.) A future
engine-level fix (or the R-X19 `rclone serve s3` VFS-cache behaviour) would only
matter if a new single-large-object writer is introduced.

**Restore from a retained volume + quiesce hardening shipped 2026-06-17.** A
destructive shrink/archive leaves the old Longhorn volume detached + `Released`
with its snapshots intact (`longhorn-tenant` is `reclaimPolicy: Retain`). New
admin **"Restore from a retained volume"** card (`RetainedVolumesCard`) rolls a
tenant back onto a chosen retained snapshot (quiesce → Longhorn `snapshotRevert`
→ rebind PVC by `volumeName`, quota raised; current volume kept as a `Released`
fallback) — the recovery path for `SNAPSHOT_VOLUME_MISMATCH`. The orphan reaper
skips `Released` volumes that still hold a restorable snapshot. Backend +
api-contracts + UI + reaper guard all shipped; full browser E2E. **And the
single-node destructive-shrink quiesce hang is fixed** (3 layered bugs: SDK
dropped `replicas: 0` → `/scale` subresource; file-manager auto-restart fought
quiesce → `insula.host/storage-quiesced` hold annotation; pod stuck `Terminating`
→ force-delete). See [TENANT_SNAPSHOTS.md](../operations/TENANT_SNAPSHOTS.md) and
[RETAINED_VOLUME_RESTORE.md](RETAINED_VOLUME_RESTORE.md).

**Force-cancel restores workloads — fixed 2026-06-18 (R19 fully closed).**
quiesce now persists the pre-quiesce replica snapshot *before* scaling anything
down (capture → persist → apply), so `…/storage/cancel` (or a crash) mid-op
always has the data to `unquiesce` every workload back to its prior replica
count instead of leaving the tenant scaled to 0. Live-proven: a shrink cancelled
mid-`quiescing` returned the tenant to idle with the file-manager restored to
its prior replicas. **No open items remain in R19.**

## R20 — Cross-cluster tenant migration

**Design captured, not built.** Tenant backups are already cluster-agnostic
(keyed by `bundleId` UUID + `meta.json.tenantId`, no cluster in the path), and
system/mail/etcd backup paths are now namespaced by a stable `cluster_id`
(2026-06-14) — so the substrate for "export a tenant bundle from cluster A →
import into cluster B" exists. The actual move feature (the export/import
orchestration + cutover) is not yet implemented. R1 (Plesk inbound) and
within-cluster restore exist; cluster-A→B does not.

Related DR follow-up: **break-glass shim reachability — addressed 2026-06-16.**
The etcd restore is now a three-tier ladder that no longer depends on a live
cluster: **Tier 0** `restore-etcd-local.sh` (local k3s snapshot, zero network),
**Tier 1** `restore-etcd-from-shim.sh --offline` (reads the decrypted `system`
target from `dr-system-target.json` in the age-encrypted bundle and pulls direct
from the real upstream S3 — no kubectl/shim), and **Tier 1b** the original
kubectl→shim path. `platform-ops dr preflight` checks readiness ahead of a
disaster. Runbook:
[BACKUP_RCLONE_SHIM.md → Recover etcd](../operations/BACKUP_RCLONE_SHIM.md#recover-etcd--tiered-break-glass).
Residual: an `--offline` path for SFTP/CIFS upstreams (S3-only today); postgres/
mail restores still run after the cluster is back (by design).
