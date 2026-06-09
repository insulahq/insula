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
| [R1](#r1--plesk-migration-service) | Plesk migration service | **P1** | Not started |
| [R2](#r2--monitoring-stack-decision--slislo) | Monitoring stack decision + SLI/SLO | **P1** | Not started |
| [R3](#r3--load-testing-in-ci) | Load testing in CI | P2 | Framework exists, unwired |
| [R4](#r4--fbl-complaint-processing) | FBL complaint processing | **P1** (for production mail) | Not started |
| [R5](#r5--dmarc-aggregate-report-ingestion) | DMARC aggregate-report ingestion | P2 | Not started |
| [R6](#r6--rolling-sending-quota-enforcement) | Rolling sending-quota enforcement | P2 | Partial (Stalwart throttles only) |
| [R7](#r7--ip-warm-up-pools-and-per-domain-relay) | IP warm-up, pools, per-domain relay | P3 | Not started |
| [R8](#r8--notification-channels-slack--webhook--sms) | Notification channels: Slack/Webhook/SMS | P3 | Email + in-app shipped |
| [R9](#r9--staff-role-email-access) | Staff-role email access | P3 | Not started |
| [R10](#r10--bulwark-deferred-work) | Bulwark deferred work (phases 7–8) | P3 | Deferred by decision |
| [R11](#r11--security-hardening-phase-2) | Security-hardening Phase 2 (+ Trivy revisit) | P2 | Phase 1 shipped |
| [R12](#r12--service-to-service-mtls) | Service-to-service mTLS | P3 | NetworkPolicy-only today |
| [R13](#r13--ipv6-completion) | IPv6 completion | P3 | Dual-stack firewall + DNS AAAA only |
| [R14](#r14--user-manual-website) | User-manual website | P2 | Not started |
| [R15](#r15--component-cve--version-watch) | Component CVE & version watch | P2 | Shipped (ADR-050) — ongoing operation |

---

## R1 — Plesk migration service

The original mission gate ("first Plesk customer migrated", Phase-1 Week 12).
Extract domains, sites, databases, mailboxes, cron jobs, and DNS from a Plesk
server and import them as platform tenants. The existing `tenant-migration`
module is worker re-pinning — unrelated.

- Spec material: the original migration plan (per-client checklist,
  Plesk/cPanel/Virtualmin extraction details, rollback plan) — see the git
  history; cron extraction details in the migration sections of
  [CUSTOMER_CRON_JOBS.md](../features/CUSTOMER_CRON_JOBS.md).
- Building blocks already shipped: `mail-imapsync` (mailbox import), tenant
  bundles restore cart (import path), DNS zone import.
- Acceptance: one real Plesk subscription migrated end-to-end onto a test
  cluster (site serves, mail flows, DB intact, cron firing).

## R2 — Monitoring stack decision + SLI/SLO

Decide once: deploy a Prometheus/Alertmanager(/Grafana) stack, or formally
adopt the built-in `metrics`/`node-health`/`cluster-health` modules as the
platform's observability answer and right-size the docs. Today SLOs, burn-rate
alerts, and cert-expiry alert rules exist only on paper.

- Target SLOs and alert rules: [roadmap/SLI_SLO_DEFINITION.md](SLI_SLO_DEFINITION.md)
  (moved here — unmeasurable until this item lands).
- If "built-in" wins: implement cert-expiry + SLO-breach alerts through the
  existing notifications system, and rewrite `MONITORING_OBSERVABILITY.md`
  to describe reality.

## R3 — Load testing in CI

`scripts/benchmark/api-load-test.js` (k6) + `run-benchmark.sh` exist but run
nowhere. Wire into CI (manual-dispatch or nightly), capture baselines, enforce
the documented p95 < 500 ms target on core endpoints.

## R4 — FBL complaint processing

Feedback-loop ingestion (ARF parsing) with complaint-rate thresholds and
automatic throttle/suspend of offending tenants. Required before operating
mail-sending tenants at scale.

- Spec: the original email sending-limits & monitoring spec (FBL sections; see
  the git history). Note: its `email_messages` per-message tracking table is
  **descoped** — design complaint handling without it.

## R5 — DMARC aggregate-report ingestion

Parse aggregate reports (Gmail/Outlook/Yahoo), compute per-domain pass rates,
surface in the email UI, and recommend policy tightening (p=none →
quarantine → reject) once pass-rate thresholds hold.

- Spec: the original email-deliverability spec (DMARC sections; see the git history).

## R6 — Rolling sending-quota enforcement

Per-tenant hourly/daily send quotas with rolling windows. Today only static
Stalwart throttles + the `emailSendRateLimit` field exist; there is no
rolling accounting or enforcement pipeline.

- Spec: the original email sending-limits & monitoring spec (quota sections;
  see the git history). Ignore the Postfix policy-daemon mechanics — we run Stalwart.

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

Remaining Phase-2 surface from the hardening epic: K8s posture tab,
auth/audit metrics tab, NetworkPolicy templates + bulk apply, plus the
deferred denied-connection → trusted-range bridge (P2.3.1). Trivy CVE
scanning stays deferred until operator demand surfaces.

- Spec: the original security-hardening roadmap (§Phase 2) — see the git history.

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
