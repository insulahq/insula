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
| [R3](#r3--load-testing-in-ci) | Load testing in CI | P3 | Not built — low value for the traffic profile (decision 2026-06-20) |
| [R4](#r4--fbl-complaint-processing) | FBL complaint processing | **P1** (for production mail) | Shipped (PRs #64–#69) |
| [R5](#r5--dmarc-aggregate-report-ingestion) | DMARC aggregate-report ingestion | P2 | Not started |
| [R6](#r6--rolling-sending-quota-enforcement) | Rolling sending-quota enforcement | P2 | Shipped (PRs #64–#69) |
| [R7](#r7--ip-warm-up-pools-and-per-domain-relay) | IP warm-up, pools, per-domain relay | P3 | Not started |
| [R8](#r8--notification-channels-slack--webhook--sms) | Notification channels: Slack/Webhook/SMS | P3 | Email + in-app shipped |
| [R9](#r9--staff-role-email-access) | Staff-role email access | P3 | Not started |
| [R10](#r10--bulwark-deferred-work) | Bulwark deferred work (phases 7–8) | P3 | Deferred by decision |
| [R11](#r11--security-hardening-phase-2) | Security-hardening Phase 2 (+ Trivy revisit) | P2 | Shipped — K8s posture + auth tabs + NetworkPolicy bulk-apply + operator→trusted-range bridge (2026-06-18) + upstream-image Trivy CVE scan (CI, 2026-06-20); only in-cluster Trivy UI deferred |
| [R12](#r12--service-to-service-mtls) | Service-to-service mTLS | P3 | NetworkPolicy-only today |
| [R13](#r13--ipv6-completion) | IPv6 completion | P3 | ✅ **CLOSED 2026-08-10** — serving IPv6 is done and re-proven on a from-scratch dual-stack install (smoke 29/0 over both families, integration-all 43/0/2). Residual end-to-end-v6 *purity* work moved to [R27](#r27--dual-stack-tenant-services-end-to-end-ipv6); the `V6ThenV4` flip is an operator reputation decision, not tracked work |
| [R14](#r14--user-manual-website) | User-manual website | P2 | Shipped — live at insulahq.github.io |
| [R15](#r15--component-cve--version-watch) | Component CVE & version watch | P2 | Shipped (ADR-050) — ongoing operation |
| [R16](#r16--decouple-ingress_domain-from-platform_domain--turnkey-apex-rename) | Decouple ingress/platform domain + apex rename | P2 | Shipped (2026-06-13/14) — §3e DNS automation + live per-worker tunnel subdomains residual |
| [R17](#r17--mail-housekeeping-follow-ups-2026-06-10-single-node-green-up) | Mail/snapshot housekeeping follow-ups | P2 | Shipped (PRs #22–#39) — all three follow-ups done incl. Released-PV operator surface |
| [R18](#r18--operator-script-consolidation-into-the-platform-ops-cli) | Operator-script consolidation → platform-ops CLI | P2 | Shipped (T1–T4 + R18-finish) — released v2026.6.10 |
| [R19](#r19--tenant-on-server-snapshots--storage-resize-hardening) | Tenant on-server snapshots + storage-resize hardening | P2 | ✅ Shipped — snapshots + in-place/retained-volume restore + destructive-shrink quiesce + force-cancel restore all done (2026-06-17/18) |
| [R20](#r20--cross-cluster-tenant-migration) | Cross-cluster tenant migration | P3 | ✅ Shipped 2026-07-08 — mount source read-only → list → import (single/all) + guided UI; DEV E2E 11/0 |
| [R21](#r21--k3s-multi-minor-auto-step-adr-045--implementation-gap) | k3s multi-minor auto-step (ADR-045 ↔ code gap) | P3 | ✅ Shipped 2026-06-21 — `cluster upgrade` auto-steps multi-minor (auto-loop chosen) |
| [R22](#r22--rc-validation-on-staging-via-flux-adr-045-mode-b) | RC validation on staging via Flux (Mode B) | P3 | ✅ Shipped 2026-06-21 — Flux re-pin now accepts `-rc.N` tags (gated by the prerelease flag) |
| [R23](#r23--insula-single-binary-install--branding) | `insula` single-binary install + branding | P2 | Proposed (ADR-055, 2026-07-26) — fold bootstrap into the signed binary; rename `platform-ops`→`insula`; consolidate host paths |
| [R24](#r24--proxy-protocol-support-for-cloud-load-balancers) | PROXY-protocol support for cloud (SNAT) load balancers | P2 | Proposed 2026-07-26 — real client IP is lost behind a SNAT-ing cloud LB (neither Traefik nor HAProxy accept inbound PROXY protocol); today needs a source-preserving L4-passthrough LB or DNS multi-A |
| [R25](#r25--migration--dr-recover-completeness) | Migration / DR-recover completeness | P2 | Proposed 2026-08-04 — a recreated tenant needs manual follow-up steps (database replay, email re-enable); fold them into the recreate engine |
| [R26](#r26--pin-the-k3s-installer-to-a-version-tag-not-master) | Pin the k3s installer to a version tag, not master | P2 | Proposed 2026-08-04 — get.k3s.io serves master, so any upstream edit to install.sh breaks every fresh install until the digest is re-pinned |
| [R27](#r27--dual-stack-tenant-services-end-to-end-ipv6) | Dual-stack tenant Services (end-to-end IPv6) | P4 | Proposed 2026-08-10 — the residual from R13: globally-routable pod addressing + catalog images binding `::`. COUPLED and inert individually; both only become load-bearing if tenant Services stop being SingleStack IPv4. Needs a provider-delegated prefix |
| [R28](#r28--make-email-aliases-and-auto-reply-real) | Make email aliases + auto-reply real (Stalwart-backed) | P2 | ✅ **CLOSED 2026-08-24** — auto-reply (vacation), aliases (Stalwart MailingList per alias, fan-out to local + external destinations) and the domain catch-all (native Domain.catchAllAddress) all enforced by the mail server, DB authoritative with boot reconcile |

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

**Not built — decided against on 2026-06-20 (low value for the traffic profile).**
The k6 framework (`scripts/benchmark/api-load-test.js` + `run-benchmark.sh`)
targets the management API (admin/tenant panels), which is operator/tenant-facing,
low-concurrency, and already fast (p95 ~200 ms measured against testing). A
capacity stress test there solves a problem the platform doesn't have — and a
single shared token can't generate real load anyway (the per-user rate limit,
~100/min, correctly returns 429). A *true* stress test would need many benchmark
accounts (one user per VU), which isn't worth it for panels nobody hammers.

The traffic-bearing, capacity-sensitive paths are tenant-hosted sites (their own
app perf + an infra-sizing question — see `docs/operations/INFRASTRUCTURE_SIZING.md`)
and mail — and those **already have perf harnesses**:
`integration-stalwart-storage-perf.sh`, `integration-stalwart-export-perf.sh`,
`bench-imap-vs-jmap.sh` (mail) and `integration-shim-perf.sh` (backup/rclone).

The k6 script is kept for ad-hoc local benchmarking (`BASE_URL=… EMAIL=… PASSWORD=…
k6 run scripts/benchmark/api-load-test.js`). Revisit only if the panels ever face
real concurrent load.

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

- **Trivy upstream-image CVE scan** — **shipped 2026-06-20 (CI, ADR-050).** Weekly
  + on-demand `.github/workflows/image-cve-scan.yml` Trivy-scans the upstream
  images we deploy (Stalwart, Postgres, CrowdSec, …) for OS/library CVEs the
  version+advisory watch can't see — entirely in CI, no cluster. Skips
  `cve-ledger.yaml`-tracked findings, fails on a new untracked HIGH/CRITICAL.
  Closed the gap that left the Stalwart image's Debian base CVEs unscanned (the
  first run surfaces 22 HIGH + 4 CRITICAL in `stalwart:v0.16.5`). TDD helpers +
  security/code review + local E2E against the real Stalwart image.

**Open:**
- **In-cluster Trivy scanning UI** — deferred until operator demand surfaces. The
  CI scan above covers the actual CVE-detection need; an in-panel UI is cosmetic.

**Deferred from the 2026-07-27 security review** (medium/low items whose fix is a
redesign or carries regression risk disproportionate to the current, mitigated
exposure — recorded here so they are not lost):

- **Per-tenant hostPort opt-in (was M8).** Flipping the cluster-wide
  `allowHostPorts{Server,Worker}` toggle relabels **every** tenant namespace to
  PodSecurity `enforce: privileged` (`tenant-psa-reconciler.ts`). Not exploitable
  today — tenants cannot submit raw pod specs (the custom-deployment schema has no
  hostPath/privileged, `capAdd` is allowlisted to `NET_BIND_SERVICE`, `allowRoot`
  is admin-only) — but it removes the PSA backstop cluster-wide instead of only
  for the tenants that actually need a hostPort. Proper fix: track hostPort opt-in
  per tenant and label only those namespaces `privileged`, leaving the rest
  `baseline`. Feature-flag redesign; deferred.

- **rsync flag allowlist (was low).** The sftp-gateway confines `rsync --server`
  with a comprehensive, repeatedly-hardened **denylist** (`session.go`) on the
  unchrooted-root exec path. It is sound, but a denylist must chase every new
  dangerous rsync flag; an allowlist ("only these server flags are permitted")
  fails safe against future rsync releases. Convert once it can be exhaustively
  tested against a matrix of real rsync client versions (regression risk otherwise).

- **Rate-limit key hardening (was low, trustProxy).** Fastify runs with
  `trustProxy: true` (load-bearing: OIDC needs `request.protocol==='https'`), so
  the login rate limiter keys on the leftmost `X-Forwarded-For`. This is currently
  unspoofable because Traefik pins `forwardedHeaders.trustedIPs=127.0.0.1/32` and
  overwrites client-supplied XFF — but it is one Traefik config change from
  bypassable. Follow-up: key the limiter on the Traefik-set `X-Real-IP` (already
  treated as unspoofable in `security-hardening/crowdsec-l4.ts`) and/or add a CI
  guard asserting the Traefik `trustedIPs` value stays pinned.

## R12 — Service-to-service mTLS

In-cluster platform-service traffic is NetworkPolicy-segmented but
unencrypted. Evaluate mTLS (mesh or per-service certs) per
`SECURITY_ARCHITECTURE.md` Phase-2 notes.

## R13 — IPv6 completion

Requirements doc: [roadmap/IPV4_IPV6_REQUIREMENTS.md](IPV4_IPV6_REQUIREMENTS.md) (moved here).

**Why this sat unbuilt.** The requirements doc has scoped IPv6 into *Phase 1.5,
week 13* since 2026-03-24 — its own success-criteria table reads "IPv6 support:
Phase 1 = No" — because k3s dual-stack needed the Flannel→Calico migration
first. That migration shipped (bootstrap runs `--flannel-backend=none` + the
Tigera operator), but the dual-stack step behind it was never scheduled, and a
second constraint accumulated in the meantime: k3s requires `--node-ip` and
`--cluster-cidr` to carry the same families, so a dual-stack cluster CIDR with a
v4-only node IP fails worker join. With the mesh-underlay mode pinning
`--node-ip` to a v4-only NetBird/Tailscale address, single-stack won by default
and the comment in `install_k3s_server` hardened into "we don't expose IPv6
anywhere in the platform".

**Shipped 2026-08-04 — opt-in `--dual-stack`.** Default behaviour is unchanged;
a cluster is dual-stack only when the operator asks at install time (cluster
CIDRs are immutable in k3s, so this cannot be flipped later without a rebuild).

- `bootstrap.sh --dual-stack` → dual `--cluster-cidr`/`--service-cidr`,
  `--node-ip=<v4>,<v6>` on servers **and** workers, `--node-external-ip` with
  both families, a Calico IPv6 IPPool + `nodeAddressAutodetectionV6`, and
  `net.ipv6.conf.all.forwarding=1` (with `accept_ra=2`, or the node loses its
  own default route). `--pod-cidr-v6` / `--service-cidr-v6` override the ULA
  defaults.
- Refuses rather than guesses: no usable node IPv6 → fail at preflight, before
  the first mutation. On a pinned underlay, a v6 that is not inside
  `--cluster-network-cidr-v6` → refuse, rather than silently sending pod
  traffic outside the mesh.
- A node that *has* IPv6 but is being installed single-stack now says so at
  preflight — the one moment the choice is still free.
- Data path: Traefik Service `PreferDualStack` (it carries the node
  externalIPs), `ingress-external-ips` collects both families, HAProxy mail
  binds `:::<port> v4v6` (works on single-stack too — it is hostNetwork), and
  `webmail.<domain>` gains an AAAA when `INGRESS_DEFAULT_IPV6`/`MAIL_SERVER_IPV6`
  is set.
- Proof: `scripts/test-bootstrap-dual-stack.sh` (42 assertions, half of them
  guarding that the single-stack path is byte-identical) and
  `VMTEST_DUAL_STACK=1` on the VM tier, which gives the libvirt network a ULA
  v6 subnet and then asserts on the live cluster that the node registered both
  families, Calico programmed a v6 pool, and **the ingress actually answers over
  IPv6** — the one thing no unit test can see.

**Blast-radius sweep, 2026-08-05 (VM run `6e9e214b`, 3 servers + 1 worker).**
Every public surface was driven over both families from an OFF-CLUSTER client,
with IPv4 as the control for each v6 assertion. All green: panels/API (200 on
all 4 nodes), a real tenant workload on its own domain (200 with the tenant's
own content from all 4 nodes, 3 of them forwarding cross-node), SFTP `:23022`
(SSH banner on all 3 server nodes), and mail `25/587/465/993` — both with
Stalwart on its original node and again **after migrating it to another node**,
where the `stalwart-haproxy` DaemonSet correctly re-reconciled (old active node
gained haproxy, new active node dropped it). Cross-tenant isolation was verified
to hold over IPv6 as well as IPv4.

Three defects the sweep found, all fixed here:
- **`--node-external-ip` published IPv4 only on a pinned underlay.** The v6 was
  appended in the public-underlay branch but not the mesh/VLAN one, so the Node
  object carried a v4-only ExternalIP and `ingress-external-ips` published a
  v4-only list. Both branches now use a `global-only` address detector — a ULA
  is fine for `--node-ip` but must never be *announced* as externally
  reachable, so a ULA-only host correctly announces no v6 at all.
- **The `platform-cluster-cidrs` ConfigMap was never created, on any cluster.**
  Its guard read a name that was `local` to a sibling function. Invisible on
  IPv4-only (the backend's built-in defaults match), but on dual-stack it cost
  tenants *all* IPv6 egress: with no v6 CIDRs to except,
  `buildTenantNetworkPolicies` emitted no `::/0` rule, and an egress policy with
  no v6 rule denies v6 outright. A tenant pod could reach the node over IPv4 but
  not IPv6 — so a tenant app resolving `mail.<apex>` to its AAAA could not send
  mail. Both consumers now share one `cluster_cidr_args()` helper, and
  `resolveTenantNetworkCidrs` additionally falls back to the nodes' own
  `spec.podCIDRs` so existing dual-stack clusters self-heal without a rebuild.
- **The pod-CIDR control-plane firewall exemption was IPv4-only.** The nft table
  is family `inet`, so `ip saddr` matches v4 exclusively; dual-stack now emits
  the matching `ip6 saddr` rule. Inert while Services stay `SingleStack [IPv4]`,
  but a trap the day they don't.

**Pod addressing is ULA + natOutgoing**, mirroring the IPv4 model: the node's
global v6 is what clients talk to and CNI portmap DNATs hostPort down to the
pod. That satisfies the requirement (v6-only clients reach panels, API, tenant
routes, mail) without depending on the provider routing a delegated prefix.
Giving pods globally-routable addresses — true end-to-end v6, no NAT — remains
open.

**Measured 2026-08-08 — neither of the first two items is needed to SERVE IPv6.**
Traced end to end on the dual-stack DEV cluster with a real tenant workload
(nginx-php from the catalog, its own domain, fetched from a v6-capable host):

- Every Service in the cluster is `ipFamilies: [IPv4] SingleStack`, and the
  tenant's EndpointSlice is `addressType: IPv4 -> 10.42.x.x`. The
  ingress→workload hop is IPv4 **by construction**.
- A v6-only fetch (`curl -6 --resolve <host>:443:[<node v6>]`) returned the
  workload's own response with `peer=<node's public v6>`, three times. The
  client plane is v6; the internal plane never is.
- The nginx-php image **already** binds `::` (`:::8080`, `:::9000`) — and it
  makes no difference, because nothing dials the pod over v6.
- Pods already have working OUTBOUND v6 through the ULA + `natOutgoing` path
  (`curl -6 https://ipv6.google.com` → 200 from inside a tenant pod).

So "keep IPv4 for internal routing, serve the public surface over v6" is not a
compromise to be replaced later — it is the shipped design, and it satisfies the
requirement.

**CLOSED 2026-08-10.** Re-proven from scratch after the install path was found
BROKEN: `--dual-stack` bootstrap died at "Installing Traefik v3" because
`externalTrafficPolicy` was being set on a ClusterIP Service with no
`externalIPs` yet — a regression introduced AFTER R13 was marked shipped on
08-04, invisible to every test because only a FIRST install reaches it. Fixed
and guarded by `scripts/ci-service-etp-check.sh` (both directions). A wipe +
re-bootstrap then produced a clean first install, and:

- `make smoke` **29 PASS / 0 FAIL**, with admin, tenant and dex each passing over
  **both** families — the smoke matrix previously probed only one, because a
  dual-stack node's two addresses were space-joined into a single malformed
  `--resolve`.
- Full `integration-all.sh` **43 passed / 0 failed / 2 skipped**, the two skips
  being multi-node-only suites that still assert their single-node guards.
- Mail serves on 25/465/587/143/993/4190 with a real Let's Encrypt certificate;
  reverse DNS is graded per family (a missing IPv4 PTR fails the primary send
  path, a missing IPv6 PTR warns — mail still leaves over IPv4).

The remaining items are **end-to-end v6 purity, not serving**, and are tracked
together in [R27](#r27--dual-stack-tenant-services-end-to-end-ipv6) because
neither is actionable alone: globally-routable pod addressing and catalog images
binding `::` only become load-bearing if tenant Services stop being SingleStack
IPv4, and doing either before that creates untested surface.

Not tracked as work: flipping Stalwart's `MtaIpStrategy` to `V6ThenV4`. Outbound
IPv6 already works (the default `V4ThenV6` uses it as the fallback); making it
*preferred* is a deliverability/reputation decision for the operator.

**The VM tier points Stalwart's ACME at PRODUCTION Let's Encrypt, and burns its
rate limits** (found 2026-08-06 on run `6e9e214b`).

`bootstrap.sh` and `stalwart-domain-reconciler.ts` both hardcode Stalwart's own
AcmeProvider to `https://acme-v02.api.letsencrypt.org/directory`. The VM harness
overrides ACME to Pebble for *cert-manager* but not for Stalwart, which has no
override hook at all. So every throwaway VM cluster asks **real** Let's Encrypt to
validate a private test apex that will never resolve publicly. Observed on this
run: `x:Certificate/get` empty (no cert ever issued), and an `AcmeRenewal` task
chain going back to bootstrap with `failureReason: "Rate limited. Retry after 689
seconds"` after 10 failed attempts.

Consequence: **the VM tier can never hold a valid mail certificate**, so every
mail-TLS assertion is untestable there and `integration-mail-external-reachability`
cannot pass its cert probe on that tier by construction. Production is unaffected —
`mail.<apex>` resolves publicly and HTTP-01 completes through Traefik →
`stalwart-mail-acme` → Stalwart.

Let's Encrypt states the cause itself, so this needs no further diagnosis:

```
Authentication failed: "Status: invalid; Challenge type: http-01, error:
 urn:ietf:params:acme:error:dns: DNS problem: NXDOMAIN looking up A for
 mail.<vm-apex> - check that a DNS record exists for this domain;
 DNS problem: NXDOMAIN looking up AAAA for mail.<vm-apex>"
```

**Stalwart's ACME client DOES honour the system trust store — proven, not
inferred** (2026-08-06). Masking `/etc/ssl/certs` with a single decoy root and
forcing a fresh order changed the failure from an application-level LE response
to a transport failure, and restoring it brought the full ACME exchange back:

| `/etc/ssl/certs` | ACME task failureReason |
|---|---|
| real (150 roots) | `Rate limited. Retry after 677 seconds` (reached LE) |
| masked (1 decoy) | `HTTP error: error sending request for url (…/directory)` |
| restored | full ACME exchange → LE's NXDOMAIN authorization error |

A `curl` control inside the container tracked it exactly (`200 → 000 → 200`), so
nothing else moved. The `webpki-roots` crate is linked but is not what ACME uses.

So pointing the VM tier at Pebble is viable. What it takes:
1. An env/setting hook for the `directory` value — `bootstrap.sh` and
   `stalwart-domain-reconciler.ts` both hardcode it.
2. Pebble's root mounted at a path the binary probes. `/etc/ssl/certs/ca-certificates.crt`
   is the first entry in the compiled-in probe list, so that works — but mount the
   **whole `/etc/ssl/certs` directory** with a bundle of *system roots + Pebble*.
   Replacing only the `.crt` file is a no-op: the hashed `*.0` files in that
   directory still serve the real roots (verified — `curl` was unaffected until
   the whole directory was masked).
3. Do NOT rely on `SSL_CERT_FILE` / `SSL_CERT_DIR` — 0 occurrences in the binary.
   The CA has to land at a probed path.

The harness already has the Pebble root in a `platform-extra-ca-trust` Secret in
the `mail` namespace (for Bulwark); it is simply not mounted into the stalwart
container. An alternative that sidesteps all of it: give the VM tier a publicly
resolvable throwaway apex.

*Aside, cost me two inconclusive experiments:* **Stalwart's task scheduler does not
reliably run a task at its `due` time.** AcmeRenewal tasks sat past due, unchanged,
until destroyed and re-queued (`x:Task/set destroy` + `stalwart-reprovision`). Any
test that waits on a Stalwart task firing on schedule will hang instead of failing.

> **Retracted (rate limits):** an earlier revision claimed production "shares the
> rate-limit pool" with VM clusters. That is not supported. The limit actually
> being hit is a per-account/per-hostname failed-validation limit, scoped to each
> disposable cluster's own throwaway LE account, and the VM clusters never issue a
> certificate so they consume none of the per-registered-domain quota. The only
> genuinely shared surface is new-accounts-per-IP, which is shared between VM runs
> on a common egress IP — not with production, which egresses elsewhere.

> **Retracted:** an earlier revision of this entry claimed Stalwart *drops its
> mail certificate on pod restart*. That was wrong. It was an artifact of the
> reachability suite scoring an EMPTY issuer read as a valid certificate: while
> the prober was banned no TLS handshake completed, `openssl` returned nothing,
> and the probe went green; clearing the ban made the same permanently
> self-signed listener go red, which looked like a regression caused by the
> restart. Nothing changed across the restart — the listener had been serving
> `CN=rcgen self signed cert` since bootstrap. The empty-issuer branch now fails
> with `cert=UNREADABLE` instead of passing.

**Closed 2026-08-06** (were listed here as open):
- *The node's IPv6 is invisible in the admin panel* — migration 0080 adds
  `cluster_nodes.public_ipv6`, node sync selects per family, and the panel's
  node row shows it. Also un-deadens the node-sourced half of AAAA domain
  verification.
- *A guard for AAAA published while the cluster is single-stack* — smoke test
  10, with `scripts/test-smoke-aaaa-guard.sh` covering all four branches
  offline. It also catches the inverse (a dual-stack cluster whose AAAA
  resolves but does not serve) and the case that made the first live run
  misreport: `getent ahostsv6` returns IPv4-**mapped** addresses for A-only
  hosts, which reads as "publishes AAAA" and would have failed every hostname
  on every single-stack cluster.
- *Stalwart's `x:AllowedIp` seeds v4 CIDRs only* — now follows the dual-stack
  pod/service CIDRs, one entry per family.
- *Nothing told an operator that a dual-stack cluster published no AAAA* — a new
  `ipv6Dns` deliverability sub-probe warns on **Email → Data Drift** (and in the
  mail-health details modal) when `mail.<apex>` has missing, partial, or stale
  AAAA on a cluster that serves IPv6. Warning, never fail: mail works over IPv4,
  and red-lighting the dashboard over a reachability nicety trains operators to
  ignore it.

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

Enhanced 2026-06-20 after a tier-0 (Stalwart) drift went unnoticed in the quiet
rolling issue: the sweep now leads with a **⚠️ Tier-0 components behind upstream**
callout; a new weekly **upstream-image Trivy scan** (`image-cve-scan.yml`, see
[R11](#r11--security-hardening-phase-2)) covers base-OS CVEs the version/advisory
watch can't; and `component-watch.sh --changelog <id>` surfaces the upstream
release notes (breaking changes flagged) required before bumping a tier-0 pin.

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

**✅ Shipped 2026-07-08.** Tenant backups are cluster-agnostic (keyed by `bundleId`
UUID + `meta.json.tenantId`, no cluster in the path), so cluster B just needs
READ access to A's target — no prep on A. Cluster B mounts A's tenant backup
target read-only (a backup config on B, or sourced from A's secrets bundle on a
fresh cluster), scans it (`POST /admin/migration/list-tenants`), and imports
single/all (`POST /admin/migration/import`). Import reuses the DR recover engine
(`recreateTenantFromBundle` re-creates the tenant from `meta.json` preserving
id+ns, then reconciles ingress/DKIM/workloads), pointed at the source target
(`resolveDirectStoreForBundle(..., {classSubpath:'tenant'})` so the direct store
reads under the shim's `<prefix>/tenant/` layout). Locally-present tenants are
skipped; dry-run preview. Guided UI: **DR console → Migrate Tenants** (shows each
tenant's effective quotas before import).

**Plan-independent** (2026-07-08): a tenant's effective params = per-tenant
override ?? plan baseline, but the SOURCE plan isn't in the bundle — so the meta
now captures the RESOLVED `effectiveResources` (cpu/memory/storage/maxSubUsers/
maxMailboxes/mailboxSize/email-rate/price), list-tenants surfaces them, and import
PINS them as explicit `*_override` columns on the destination. A migrated client's
quotas stay byte-identical regardless of how the destination's plans are defined.
DEV E2E `scripts/integration-migration-e2e.sh` 14/0 (capture → delete → list [asserts
effective override surfaced] → import → namespace back + site SHA match + override
PINNED on the destination). Cutover (DNS re-point) + source decommission
stay operator-driven — see [operations/CROSS_CLUSTER_MIGRATION.md](../operations/CROSS_CLUSTER_MIGRATION.md).
R1 (Plesk inbound) + within-cluster restore already existed; cluster-A→B now does too.

Related DR follow-up: **break-glass shim reachability — addressed 2026-06-16.**
The etcd restore is now a three-tier ladder that no longer depends on a live
cluster: **Tier 0** `restore-etcd-local.sh` (local k3s snapshot, zero network),
**Tier 1** `restore-etcd-from-shim.sh --offline` (reads the decrypted `system`
target from `dr-system-target.json` in the age-encrypted bundle and pulls direct
from the real upstream S3 — no kubectl/shim), and **Tier 1b** the original
kubectl→shim path. `platform-ops dr preflight` checks readiness ahead of a
disaster. Runbook:
[BACKUP_RCLONE_SHIM.md → Recover etcd](../operations/BACKUP_RCLONE_SHIM.md#recover-etcd--tiered-break-glass).
The `--offline` etcd restore speaks **all three shim protocols** — S3, SFTP,
and CIFS/SMB — directly (rclone renders a 0600 upstream `rclone.conf` from the
bundled `dr-system-target.json`; creds never touch argv). Verified end-to-end
2026-07-08: `scripts/integration-dr-protocols.sh` runs the real offline break-glass
read (`--offline --descriptor --list`, `KUBECTL=/bin/false`) against real S3 +
SFTP + CIFS stores from a node — **6/6 pass on DEV**. postgres/mail restores still
run after the cluster is back (by design).

## R21 — k3s multi-minor auto-step (ADR-045 ↔ implementation gap)

> **✅ Shipped 2026-06-21 — option (a), the auto-step loop.** `planK3sUpgradePath`
> (`operations/k3s-plan.ts`) splits current→target into N single-minor hops;
> `cluster upgrade` resolves each intermediate minor's latest patch from the k3s
> channel server (`resolveMinorVersion`), applies each hop's Plans, and
> `waitForRollout`s every node onto that minor before the next hop (the final hop
> is left rolling async, like a single-minor upgrade). `buildK3sUpgradePlans` keeps
> its per-hop skip-a-minor refusal as the safety net; `ci-system-upgrade-check.sh`
> still passes. Implementation now matches ADR-045 dec. 21 ("pre-flight splits a
> multi-hop into N serial Plans"). Unit-tested (planner splitting + command
> apply-order + abort-on-failed-rollout); the stepped path was live-validated
> 1.33.10 → 1.34.8 → 1.35.5 on staging.

**Original gap (resolved).** [ADR-045](../architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)
decision 21 states the upgrade pre-flight *"splits multi-hop k3s upgrades into N
serial SUC Plans"* — i.e. crossing 1.33→1.35 is handled automatically, one minor
at a time. The **implementation does not auto-step**: `buildK3sUpgradePlans`
(`backend/src/cli/platform-ops/operations/k3s-plan.ts`) **refuses** skip-a-minor /
downgrade / cross-major, and `cluster upgrade` (`…/platform-ops/commands.ts`) is a
single-step current→target generator with no loop. So an operator crossing >1
minor today must invoke `cluster upgrade --version <next-minor> --apply` once per
minor (validating between), and auto-update **halts** on the skip-a-minor refusal
rather than walking the gap. (New installs are unaffected — `bootstrap.sh` installs
the pinned version fresh.) CI guard `scripts/ci-system-upgrade-check.sh` already
asserts the refusal.

**Decision needed:** either (a) implement the auto-step loop in `cluster upgrade`
(generate → apply → wait-for-rollout per minor, current→target) so a multi-minor
release is one button, or (b) amend ADR-045 dec. 21 to say k3s is **manual,
one-minor-per-step** and have the release pre-flight surface the required steps in
the operator prompt. Either way, document in the CHANGELOG upgrade notes that a
release bumping k3s by >1 minor requires N stepped upgrades on existing clusters.
Manually validated the stepped path 1.33.10 → 1.34.8 → 1.35.5 on staging
2026-06-21 (smoke 35/0 after each minor) — that path works; only the *automation*
of the stepping is missing.

## R22 — RC validation on staging via Flux (ADR-045 Mode B)

> **✅ Shipped 2026-06-21 — the load-bearing half: the Flux re-pin now accepts a
> prerelease tag.** `gitTagForVersion` + `repinGitRepositoryTag`
> (`platform-upgrades/flux-repin.ts`) gained an `allowPrerelease` option, and
> `runUpgrade` threads it from the `auto_update_include_prereleases` setting. So a
> staging cluster with the prerelease flag ON re-pins Flux from the `development`
> branch → the newest `-rc.N` tag (the poller already selects RCs; `semver.ts`
> already orders them). Production (flag OFF) still refuses an `-rc.N` tag even via
> an explicit `--version <rc>` — defence in depth. Only `-rc.N` is accepted (not
> arbitrary `-<sha>`/`-beta`). Unit-tested (flux-repin + orchestrate).
> **Still operator-applied:** the platform deliberately keeps *apply* operator-gated
> (the upgrade scheduler never auto-applies — see its header comment), so a fully
> hands-off staging RC auto-apply loop is intentionally NOT added here; enabling it
> for staging would be a separate decision.

**Original scope.** The RC machinery exists:
`scripts/cut-release.sh --prerelease` cuts `YYYY.M.PATCH-rc.N` (GitHub Release
`prerelease=true`); the `auto_update_include_prereleases` setting gates them (default
**ON** staging / **OFF** prod); the poller `select.ts` filters prereleases
defence-in-depth (drops both API-flagged and `-rc`-parsing tags when off, so prod
never auto-pulls or even displays an RC); and `semver.ts` orders `-rc` correctly
(`X.Y.Z-rc.1` < `X.Y.Z`, stable outranks its own prerelease). **What's deferred**
([ADR-045](../architecture/adr/ADR-045-versioning-release-cycle-and-upgrade.md)
dec. 12): staging **Mode B** — Flux pinning the newest `-rc.N` tag so a freshly-cut
RC auto-rolls onto staging through the real signed upgrade path. Staging today runs
**Mode A** only (Flux watches the `development` branch tip — every-commit
bleeding-edge), so RC-artifact validation is currently manual: flip the
include-prereleases poller flag, or `platform-ops self-upgrade --version <rc>
--force` on a canary cluster.

**Build Mode B** (Flux `spec.ref.tag` re-pinned to the latest `-rc.N` by the
version-poller on staging) to get continuous, hands-off RC rollout testing that
exercises cosign verify + migrations + the k3s stepping before a stable cut.

## R23 — `insula` single-binary install + branding

**Proposed 2026-07-26 — see [ADR-055](../architecture/adr/ADR-055-insula-single-binary-install-and-branding.md).**
Finishes the operator-tooling consolidation ([R18](#r18--operator-script-consolidation-into-the-platform-ops-cli)):
fold the last bash installer into the signed `platform-ops` binary and rebrand
the operator footprint to the product name.

Three changes, one delivery mechanism (a transition host-migration + a dual-name
release), sequenced together while the installed base is a single staging
cluster (pre-production — the cheapest window):

1. **Single-binary bootstrap.** Embed `bootstrap.sh` + `scripts/lib/*` + the
   `k8s/` overlay tree as SEA assets (the mechanism host-migrations already use)
   and add an `insula bootstrap` subcommand that extracts-and-`exec`s the bash.
   Install becomes `curl` a signed binary + run — no repo clone, cosign-verified,
   `curl`-and-run safe. **No host bash is ported to TypeScript** (reaffirms the
   R18/ADR-045 keep-as-bash line — it's about the logic, not the distribution).
   The repo path stays for dev/CI via the filesystem-dir fallback.
2. **Rename the artifact to `insula`** — release asset, install path, systemd
   `ExecStart`, docs, command examples — **keeping the internal
   `backend/src/cli/platform-ops/` module** (artifact rename, not a codebase
   refactor).
3. **Consolidate the host footprint** from five inconsistent roots
   (`/etc/platform`, `/var/lib/hosting-platform`, `/etc/hosting-platform`,
   `/var/lib/platform`, `/run/hosting-platform`) into `/var/lib/insula` +
   `/etc/insula` via `old → new` **symlinks** (not moves — the paths hold
   migration markers, DR bundles, and the cosign anchor; a physical move would
   re-trigger migrations / strand DR).

**Delivery:** fresh installs get the new names/paths from bootstrap; existing
clusters via one host-migration that re-points the systemd units + symlinks the
old names, on a transition release that ships **both** asset names so an old
node's self-upgrade can still fetch it. Host-migration markers are
name-independent, so the binary rename cannot re-trigger migrations; the path
rebrand preserves that invariant only because it uses symlinks — load-bearing,
CI-guardable. Full design + risks: ADR-055.

## R24 — PROXY-protocol support for cloud load balancers

**Proposed 2026-07-26.** Lets an operator front the cluster with a cloud
load balancer (Hetzner CCM, AWS NLB, …) **without losing the real client IP**.

**Problem.** Most cloud LBs SNAT inbound connections and convey the true client
only via **PROXY protocol**. This platform accepts inbound PROXY protocol on
**neither** edge, so a SNAT-ing LB makes every client appear as the LB's own IP.
That silently collapses per-client rate limits, CrowdSec decisions, audit-log
attribution, and — the expensive one — **mail SPF/DKIM alignment and sender
reputation** (Stalwart keys anti-abuse off the connecting IP). See the
[Production Pre-Flight Checklist § mail exposure](../operations/PRODUCTION_PREFLIGHT_CHECKLIST.md)
and [CLUSTER_NETWORK.md](../operations/CLUSTER_NETWORK.md).

**Why it's a gap — the two edges today:**
- **Web** — Traefik is a `hostPort` DaemonSet; its entrypoints carry only
  `forwardedHeaders.trustedIPs` (X-Forwarded-For trust), wired from the operator
  CIDR list by the `cluster-trusted-proxies` reconciler and surfaced in the admin
  UI (**Security → Network Trust → Trusted Proxies**). There is **no**
  `proxyProtocol.trustedIPs`. So an **L7 / XFF** LB works today (add its CIDR); an
  **L4 / PROXY-protocol** LB does not.
- **Mail** — the HAProxy `hostNetwork` DaemonSet frontends `bind *:25` (etc.) with
  **no `accept-proxy`**, and Stalwart's `-proxy` listeners trust only the pod CIDR
  (`mail-admin/proxy-networks-reconciler.ts`, reconciler-managed, **no operator
  knob**). Real IP survives **only** if the LB does source-preserving L4 passthrough.

**Proposed change (two symmetric parts + one gate):**
1. **Web** — extend the `cluster-trusted-proxies` reconciler to also emit
   `--entryPoints.{web,websecure}.proxyProtocol.trustedIPs=<csv>` from the same
   operator CIDR list (or a per-row "PROXY protocol" flag), so Traefik unwraps
   PROXY frames from a trusted LB.
2. **Mail** — add (gated) `accept-proxy` to the HAProxy frontend `bind` lines and
   an operator input that adds the LB's egress CIDR to Stalwart's
   `overrideProxyTrustedNetworks`. Surface both in the same **Trusted Proxies**
   admin tab so the config is discoverable, not YAML-only.
3. Optionally a new mail **port-exposure mode** (`externalLoadBalancer`) that
   selects the PROXY-protocol front instead of node-bound hostPorts.

**Delivery / risk.** PROXY protocol is all-or-nothing per listener — turning on
`accept-proxy` breaks every *non*-PROXY connection to that port (in-cluster
health probes, Roundcube/Bulwark, direct clients — the 2026-05-17 `errno=104`
class of regression). So it MUST sit behind an explicit "front me with a
PROXY-protocol LB" toggle and never default on; the hostPort/hostNetwork + XFF
path stays the default and remains fully supported.

**Why P2, not P1 — there is a zero-code workaround today:** DNS multi-A straight
to node IPs (no LB) **or** a source-preserving **L4-passthrough** LB both keep
real client IPs intact. This item is for operators who specifically want a
SNAT-style cloud LB VIP in front.

**Gate:** part 2 changes **mail port-exposure**, which is a "don't touch without
asking" area — this item ships only after an **ADR + operator sign-off**; the
write-up here is the proposal, not an approval to build. Related:
[R16](#r16--decouple-ingress_domain-from-platform_domain--turnkey-apex-rename)
(real-client-IP recovery groundwork), the mail HA path in
[HA_MODE](../architecture/HA_MODE.md).


## R25 — Migration / DR-recover completeness

Proposed 2026-08-04, surfaced while scoping the IPv6 blue/green migration
([R13](#r13--ipv6-completion)). Recreating a tenant from an off-site bundle —
`recreateTenantFromBundle`, used by both DR recover and cross-cluster migration
([R20](#r20--cross-cluster-tenant-migration)) — leaves the tenant **serving but
not fully reconstituted**. Each residual is individually documented and
operator-actionable today (see
[CROSS_CLUSTER_MIGRATION.md](../operations/CROSS_CLUSTER_MIGRATION.md)); the
point of this item is that an operator must know to perform them, and a migration
of many tenants multiplies the chance one is missed.

**The gaps, most consequential first:**

1. **Add-on databases are never replayed from their dump.**
   `dr-recover/recreate.ts` restores exactly `['config', 'files', 'mailboxes',
   'secrets']`. The `databases-by-id` executor — which exists, is tested, and
   knows how to find the ADR-047 `predump-<db>-<bundleId>.sql` on the tenant PVC
   and import it into the running DB pod — is **not** in that set. So a
   recreated tenant's database comes up on the *data directory* copied inside
   the `files` component: a crash-consistent snapshot of a database that was
   running at capture time. That normally recovers cleanly via journal replay,
   but it is a recovery rather than a restore, and the clean logical dump that
   was captured specifically to avoid this sits unused a few directories away.
   *Fix:* enqueue a `databases-by-id { kind: 'all' }` item as the final step of
   the recreate engine, after workload reconcile so the DB pod is running (the
   executor already SKIPs gracefully when it is not). Guard it so a failed
   replay degrades to the current behaviour + a surfaced residual, never a
   failed migration.

2. **Mail send-readiness needs a manual re-enable.** The mailboxes restore
   auto-heals the Stalwart domain and principals — mail is delivered, login
   works — but DKIM signing and mail DNS (MX/SPF/DKIM/DMARC) are not
   regenerated. The operator must re-enable each email domain. *Fix:* drive the
   existing enable path per restored email domain, or make the residual an
   explicit actionable task in the Task Center rather than a line of prose.

3. **No preflight on bundle completeness.** The import fails per-tenant when a
   bundle is unusable. For a fleet migration the operator wants the answer
   *before* starting: which tenants have a `completed` bundle, how old, which
   components. `list-tenants` already surfaces newest-bundle metadata — this is
   a presentation + hard-gate change, not new machinery.

4. **Encryption-key mismatch is discovered late.** Bundle secrets are encrypted
   with the *source* `PLATFORM_ENCRYPTION_KEY`. If B's key differs, the failure
   appears per-secret during import. *Fix:* verify decryptability of one secret
   during the dry-run and refuse up front with the remedy (bootstrap B from A's
   age-encrypted secrets bundle).

**Not in scope:** changing the bundle format or adding a `databases` component.
The dump is already captured; this item is about *replaying* it and about
telling the operator what is left to do.

**Verify:** extend `scripts/integration-migration-e2e.sh` so the probe tenant
carries an add-on database with a known row, and assert that row is present
after import **without** a manual restore cart.

## R26 — Pin the k3s installer to a version tag, not master

Proposed 2026-08-04, after a fresh install failed with:

```
ERROR: k3s installer checksum MISMATCH — refusing to execute.
  expected: d264d4d4…   actual: ed01f89f…
```

`bootstrap.sh` fetches the k3s installer from `https://get.k3s.io` and verifies
it against `K3S_INSTALLER_SHA256` (the `fetch_verified_script` supply-chain
guard). But **`get.k3s.io` serves `install.sh` from k3s master**, so the pin
breaks — and every fresh install with it — whenever upstream edits that file for
*any* reason, including changes irrelevant to us. The 2026-08-04 break was
commit `2d0f82fa`, a SUSE/SLE-Micro RPM-repo fix touching no OS we support.

The guard behaved correctly; the problem is that the thing being pinned moves
independently of anything we control, so the failure is recurring and always
arrives as a production-blocking surprise rather than a planned bump.

**Proposal:** fetch from the version-pinned tag instead —
`https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION}/install.sh` — so
the installer content is a function of `K3S_VERSION`. The checksum then changes
only when we deliberately bump k3s, which is already a reviewed pin change
covered by `ci-migration-coverage.sh`. Same trust model (upstream-published
content, verified by digest), strictly more deterministic.

**Decide before building:** this changes the download host from `k3s.io` to
`raw.githubusercontent.com`. Both are upstream-controlled and the digest check
is what actually establishes trust, but it is a change to the install path's
trust anchor and should be an explicit operator decision rather than a silent
refactor. A CI freshness check (warn when the tag's installer digest differs
from the pin) is the alternative if the host change is unwanted.

## R27 — Dual-stack tenant Services (end-to-end IPv6)

**Proposed 2026-08-10.** The residual carved out of
[R13](#r13--ipv6-completion) when that closed. Nothing here is required to SERVE
IPv6 — that is shipped and proven. This is end-to-end v6 *purity*: removing the
NAT hop, so a tenant pod has a globally-routable v6 address of its own.

Two items, deliberately tracked as ONE because neither is actionable alone and
either one shipped without the other is untested surface:

- **Globally-routable pod addressing.** Today pods get ULA + `natOutgoing`,
  mirroring the IPv4 model: clients talk to the node's global v6 and CNI portmap
  DNATs hostPort down to the pod. Buys: no NAT66 and a per-pod outbound source
  address. Changes nothing an operator or tenant can observe today, since every
  tenant's outbound v6 NATs to the node's single global v6 — exactly what IPv4
  already does. **Needs a delegated prefix from the provider**, which is why it
  is not simply a config change.
- **Catalog/runtime images binding `::`.** INERT while tenant Services are
  `ipFamilies: [IPv4] SingleStack` — the ingress→workload hop is IPv4 by
  construction, so nothing dials a pod over v6. Verified for `nginx-php` (which
  already binds `::`); other images deliberately unaudited, because there is
  nothing to fix until the Services change.

**Trigger:** only start this when tenant Services are to become dual-stack. Doing
it before then audits and changes images against a path no traffic takes.

**Explicitly NOT in scope:** flipping Stalwart's `MtaIpStrategy` to `V6ThenV4`.
Outbound IPv6 already works — the default `V4ThenV6` uses it as the fallback for
destinations with no A record. Making IPv6 the *preferred* egress path is a
deliverability/reputation decision for the operator, not engineering work.

---

## R28 — Make email aliases + auto-reply real

**Proposed 2026-08-24** (found while building send-only accounts + per-mailbox
forwarding). Two long-advertised email features are **DB-only fictions** — the
API accepts and stores them, the UI renders them, and the mail server never
hears about either:

- **Aliases** (`email_aliases`, the tenant panel's "Aliases & Forwarding" tab,
  `email_domains.catch_all_address`): rows are written but no JMAP call ever
  provisions them in Stalwart — mail to an alias address is simply rejected as
  an unknown recipient.
- **Auto-reply** (`mailboxes.auto_reply{,_subject,_body}`, the edit-mailbox
  vacation panel): stored, rendered, never pushed — no vacation response is
  ever sent.

The send-only/forwarding work shipped the missing substrate: a platform-managed
per-account Sieve script (`platform-mail-rules`, `stalwart-jmap/sieve.ts`) with
admin cross-account install, boot-time reconcile, and a raised interpreter
redirect ceiling. Follow-ups:

- **Auto-reply**: ✅ SHIPPED 2026-08-24 — `vacation` block in
  `buildMailRulesScript` (subject + dot-stuffed multi-line body), pushed on
  every auto-reply edit, converged by the boot reconcile, body required while
  enabled.
- **Aliases**: ✅ SHIPPED 2026-08-24 — one Stalwart `MailingList` per alias
  (`recipients` = destinations, local or external; fan-out verified live).
  Disable destroys the list (RCPT reject), re-enable recreates it; boot
  reconcile (`email-aliases/aliases-reconcile.ts`) converges drift and
  back-fills unprovisioned rows.
- **Catch-all**: ✅ SHIPPED 2026-08-24 — pushed onto Stalwart's native
  `Domain.catchAllAddress` (an account-alias of `*` does NOT catch; probed).

---

## R29 — Schema-validate the rest of the API surface

Follow-on from the 2026-09-05 contract audit (`scripts/audit-api-contract-drift.py`).
Every locally-declared request **body** in both panels now comes from
`@insula/api-contracts`; these two gaps remain.

### R29a — Request validation on the routes that still cast

**49 mutating routes take `request.body as unknown as X` with no parse.** On those,
a wrong or misspelled field is not a 400 — it is a field the handler reads as
`undefined` and silently skips. That is how `PATCH /admin/nodes/:name/storage/:diskKey`
returned 200 while changing nothing, and how the OIDC provider PATCH appeared to
rotate a client id it never wrote.

- Enumerate with `grep -rn "request.body as" backend/src/modules/*/routes*.ts`.
- Each needs a Zod schema in `@insula/api-contracts` and a `safeParse` in the route.
- Prefer `.strict()` on PATCH: an unknown key there is not a 400 anyone notices, it
  is a field that silently does not change.
- Author the schema from **what the handler actually reads**, never from what the
  panel currently sends — the panel is one of the two things being checked.

### R29b — Response contracts, backend-first

**510 response types already exist in the contracts package. Exactly 4 of 707
handlers validate or declare their response shape**; 527 return
`success(<whatever the service produced>)`. Those 510 types are documentation, not
contracts — nothing checks the backend against them.

The panels additionally declare **127 response shapes of their own** across 49 files.
A wrong response shape renders `undefined`: a blank field, a `NaN`, an empty list,
with no error on either side — strictly harder to notice than the request-side
failures, which at least 400.

**Do not start by pointing the frontend's 127 at the existing 510.** Authoring or
adopting a response contract from what the frontend believes launders today's drift
into the contracts package and then makes `tsc` enforce it, after which the audit
reports itself clean. Sequence:

1. Pick one surface (tenants or deployments). Have the backend assert its own
   responses against a contract — dev/test **throw**, production **warn**. Note that
   Fastify `response` schemas *strip* unknown keys, so a careless rollout can silently
   delete a field the UI needs; validate rather than serialize, or roll out per-route.
2. Measure what that turns up. Drift incidence is currently **unmeasured** — the
   2026-09-05 sample could only compare two endpoints against live JSON (both clean),
   because most DEV tables are empty and you cannot audit a shape against an empty
   collection.
3. Only once the backend is asserting its own output is it worth migrating the
   frontend's 127 — at which point every misread field becomes a compile error
   instead of a blank cell.

**Known gap in the audit tool:** it detects validation by grepping for `safeParse`,
so a route validating via a Fastify JSON schema reads as unvalidated (`recycle-pod`
did). Its coverage line is printed with every run for the same reason — a clean
section (2) means "nothing found in the covered slice", never "no drift".

---

## R30 — CrowdSec scenario buckets dilute across nodes

Scenario evaluation happens **in the agent**, per node: only finished alerts ship to
the LAPI, never raw events. Where ingress is fronted by round-robin DNS (staging today
publishes 3 A records), one client's requests spread across nodes and each agent sees
roughly 1/N of them. A burst that would trip `http-probing` on a single node can fail
to trip it on any of three.

**It degrades silently.** Every agent stays Running, parsing and healthy; there are
simply fewer alerts than the traffic warrants. Detection sensitivity drops as the
cluster grows, with no error anywhere — the worst shape a regression can take.

Unaffected today: production and DEV are single-node. **Staging is 3-node and is
affected.**

CrowdSec has no distributed-bucket mode, so the options are:

1. **Scale thresholds by node count** via a scenario override (`.../scenarios/*.yaml`
   with a lower `capacity`). Simple, but it trades false negatives for false positives
   and needs re-tuning whenever a node is added or removed.
2. **Pin a client to a node** so its whole burst lands in one bucket. Not possible with
   round-robin DNS; would need a real L4 load balancer with source-IP affinity
   (relevant to R24, PROXY-protocol support).
3. **Accept reduced sensitivity** on multi-node and rely on the community blocklist
   plus ModSecurity for those clusters.

Pick against **measured** traffic, not assumption: instrument the alert rate on staging
first and compare it with the same traffic replayed single-node. The hub scenarios'
`capacity`/`leakspeed` values decide how much dilution actually matters, and guessing
at them is how you end up with either a silent detector or a page every hour.

Related: **R31**, below — the fleet currently shares ONE machine identity, so
`cscli machines list` cannot show you which node stopped parsing.

---

## R31 — Per-node identity for the CrowdSec agents

Every agent pod authenticates as the same machine (`insula-agent`).

This is forced by the mechanism, not chosen. The LAPI registers exactly one machine —
`cscli machines add "$AGENT_USERNAME"` in the crowdsec image's own entrypoint, run
whenever `AGENT_USERNAME`/`AGENT_PASSWORD` are set — and the agent must present exactly
that name. A per-pod or per-node name has nothing to register it.

**Cost:** on a multi-node cluster all agents share one row in `cscli machines list` and
their heartbeats merge, so a single agent that has stopped parsing looks alive. Detection
still works — the surviving agents keep filling their buckets — but the *silent detector*
failure mode this platform keeps hitting is exactly the one that becomes invisible here.

**The fix** is LAPI auto-registration: `api.server.auto_registration` with a shared token
and `allowed_ranges` scoped to the cluster pod CIDR. Agents then self-register under any
name, and `<prefix>-<node>` becomes possible.

`AutoRegister` exists in the 1.7.8 config struct (`cscli config show --key
Config.API.Server` reports `AutoRegister: nil`), but the docker entrypoint exposes **no
env var** for it — the only lever is writing `/etc/crowdsec/config.yaml.local`. That
directory is an `emptyDir` the entrypoint populates at start, so a mount there risks a
LAPI that will not boot: strictly worse than merged heartbeats. Verify on DEV before
adopting, and treat "the LAPI still starts" as the first assertion.

Prerequisite for R30 — you cannot reason about per-node bucket dilution without
per-node visibility.

---

## R32 — oauth2-proxy 401 dead-end — RESOLVED 2026-09-05

A Traefik `errors` middleware (`platform-oauth2-proxy-signin`) now precedes the
ForwardAuth on every protected panel route. It catches the 401, fetches
`/oauth2/sign_in?rd={url}` from oauth2-proxy — which does redirect — and
`statusRewrites: {"401": 302}` turns it into the 302 the browser needs. The
original URL survives in the IdP `state`, so the visitor lands back where they
were.

Order is load-bearing: a Traefik `errors` middleware only sees responses from
what follows it, so placed *after* the ForwardAuth it never sees the 401. Pinned
by a unit test that fails when the two are swapped.

---

## R33 — Dex ConfigMap changes never reached the process — RESOLVED 2026-09-05

`generatorOptions.disableNameSuffixHash` was `true` on all three Dex overlays,
which switched off the very mechanism that makes a config change roll the
Deployment. Set to `false`: a content edit now mints `dex-config-<hash>`,
Kustomize rewrites the volume reference, and the pod restarts on its own.

Nothing referenced the ConfigMap by its literal name (checked across `scripts/`,
`backend/` and `platform/`), so the rename is contained.

**Still open:** other ConfigMap-driven Deployments have not been audited for the
same gap. Dex was found by accident — a nine-day-old pod serving stale config
while `kubectl get cm` showed the new value.

---

## R34 — Decide the config-reload mechanism, deliberately

The platform reloads workloads on config change **three different ways**, and
which one applies depends on who writes the ConfigMap. That ambiguity is how the
Dex gap survived nine days.

| Mechanism | Used by | Notes |
|---|---|---|
| Kustomize content-hash name | dex, crowdsec-agent, 3 error pages, 3 roundcube | atomic; cannot fail silently |
| Stakater Reloader annotations | stalwart-mail, bulwark, sftp-gateway | already deployed cluster-wide since 2026-08 |
| Bespoke `insula.host/*-hash` | trusted-proxies, waf-exclusions, feature-css, rclone-shim | 4 backend reconcilers hand-roll sha256 + patch |

Kustomize hashing **cannot** cover the third group: those ConfigMaps are written
at runtime by the backend, not rendered from git. So "one mechanism" is only
reachable by moving everything to Reloader.

**Reloader is strictly better for two things.** It does not rename, so it can
cover `platform-config` and `platform-mail-acme` — which hashing cannot, because
`dr-restore.sh` and the network smoke test look `platform-config` up by literal
name. And it would retire the four hand-rolled hash reconcilers.

**Hashing is strictly better for one thing that matters.** The new ConfigMap and
the new pod template arrive in the same apply, so there is no window where pods
run old config, and no runtime component whose failure silently stops
propagation — the exact class of failure this whole area kept producing. For
`crowdsec-agent-acquis`, which decides whether a scenario bans real users, that
guarantee is worth keeping.

**Proposed rule — two mechanisms, chosen deliberately rather than three by
accident:**

1. **Kustomize hash** for git-authored config where atomicity matters (security
   controls, ingress/WAF config).
2. **Reloader** for runtime-written ConfigMaps and anything referenced by
   literal name elsewhere.

Deliverables: an ADR recording the rule; convert the four bespoke reconcilers to
Reloader annotations; adopt Reloader for `platform-config` /
`platform-mail-acme`; a CI guard asserting every ConfigMap-consuming workload
matches one of the two. Note Reloader itself is a silent-failure surface — if it
is to carry this much, it needs an alert on its own liveness.

