# Notification System Overhaul

> **Status:** proposed · **Author:** platform · **Date:** 2026-09-14
>
> A plan to make platform notifications *useful*. Today a notification tells you that
> something happened; it does not reliably tell you **to whom**, **about what**, **how bad**,
> or **what to do** — and a meaningful share of them are never delivered at all.
>
> Every number below was measured against the live production cluster on 2026-09-14, not
> inferred from the source. Identifiers are redacted (`example.test`) per public-repo policy.

---

## 1. Evidence

### 1.1 Delivery is failing at scale

All-time `notification_deliveries` on production:

| channel | sent | dlq | skipped | failure rate |
|---|---|---|---|---|
| in_app | 180 | 0 | 0 | 0% |
| email | 76 | 85 | 16 | **57%** |
| ntfy | 94 | 0 | 0 | 0% |

Two distinct causes:

- **85 × `no_default_notification_provider`** — no default SMTP provider row exists, so
  essentially every *admin* email notification has been dead-lettering since the provider
  model shipped.
- **16 × `render_failed`** — one missing Handlebars variable, below.

### 1.2 One missing variable silently destroys a notification

Production, verbatim:

```
subscription.renewed | email | skipped |
  render_failed: Handlebars render failed: "nextBillingAt" not defined in [object Object] - 3:130
```

`subscriptions/service.ts:118` supplies `newExpiresAt`. All three templates read
`{{nextBillingAt}}`. The names never matched.

The renderer compiles with Handlebars `strict: true` (`templates/renderer.ts:62`), which
produces two different failure modes from the same mismatch:

| template form | strict-mode behaviour | observed result |
|---|---|---|
| `{{nextBillingAt}}` (bare) | **throws** | email dropped, 16/16 |
| `{{#if nextBillingAt}}…{{/if}}` | renders **empty**, no error | in-app body silently loses its date |

So the customer received `"Your subscription was renewed for another billing cycle."` — no
tenant, no plan, no date — and no email at all. Both symptoms, one root cause, zero alerts.

### 1.3 The variable contract is broken in 18 of 53 categories

Measured by loading the real seed data through node (`scripts/ci-notification-variable-contract.sh`,
added by this work) and diffing template variable references against emitter payload keys:

**FATAL — template reads a variable nobody supplies, as a bare reference → delivery dropped:**

| category | missing variable(s) | channels affected |
|---|---|---|
| `subscription.renewed` | `nextBillingAt` | email, in_app, ntfy |
| `tasks.scheduled_failure` | `taskName`, `errorMessage` | email, in_app, ntfy |
| `tenant.custom_deployment_rolled_back` | `panelUrl` | email |
| `legacy.{info,warning,error,success}` | `title`, `message` | all |

`tasks.scheduled_failure` has **no emitter at all** — templates exist for an event nothing fires.

**LOSSY — the emitter supplies data no template renders; it is collected and thrown away:**

| category | discarded data |
|---|---|
| `subscription.changed` | `oldPlanName`, `newPlanName` → body is literally *"Your subscription was modified."* |
| `admin.slo_alert_{warning,critical}` | `ruleId`, `severity`, `subjectLabels` |
| `admin.slo_alert_resolved` | `ruleId`, `severity`, `description`, `value`, `subjectLabels` |
| `subscription.expiry_warning` | `daysUntilExpiry` |
| `tls.certificate_failed` / `_fallback` | `expiresAt` |
| `tls.certificate_issued` | `errorMessage` |
| `tenant.email_quota_exceeded` | `percent` |
| `admin.tenant_pod_oom` | `restartCount` |
| `security.suspicious_activity` | `userAgent` |

**GENERIC — no identifying variable whatsoever:**

`security.password_reset`, `security.password_changed`, `subscription.changed`,
`tenant.suspended`, `tenant.restored`, `tenant.archived`, `tenant.deleted`

> *"Your account has been suspended. Contact support to restore access."* — no tenant name,
> no reason, no date, no contact, no support link.

### 1.4 Tenant identity is hardcoded out

`dispatcher/dispatch.ts:315-317` seeds every render with:

```ts
platformName: 'Hosting Platform',        // ignores system_settings.platform_name (schema.ts:2844)
userName: recipientEmail.split('@')[0],  // the email local part, not a name
tenantName: null,                        // every {{tenantName}} renders '' unless a caller passes it
```

- **8 of 24** tenant-facing categories reference `{{tenantName}}` at all.
- **0** reference the tenant's contact person. `tenants.contact_name` exists and is populated,
  and the notification system never reads it.
- `platformName` is hardcoded in **4** places (`dispatch.ts` ×2, `channels/email.ts:65`,
  `lifecycle-hooks/notify-on-transition.ts:48`), so renaming the platform changes nothing.

### 1.5 There are two parallel notification systems

| | modern path | legacy path |
|---|---|---|
| entry point | `dispatchSafe()` → `emitEvent` | `notifyUser()` / `notifyUsers()` |
| templates | yes, operator-editable | **no**, hardcoded English strings |
| email / ntfy | yes | **no — in-app only** |
| delivery audit | yes | **no rows written** |
| preferences / rate limit | yes | **bypassed** |

**67 of ~220** production in-app notifications are `legacy.*` (39 success, 23 info, 5 error)
with **zero** delivery rows. The events on the legacy path are precisely the operational
tenant-facing ones: IMAPSync completed/failed, email enabled for a domain, mailbox limit
reached, DKIM rotated, and mailbox quota. **None of these has ever reached a tenant by email.**

Nine call sites still use it: `backup-health`, `cnpg-backup-health`, `backup-restore`,
`eol-scanner` (×3), `mail-stats/quota-notifications`, plus four helpers inside `events.ts`.

### 1.6 The mailbox quota chain has never fired

`mail-stats/quota-notifications.ts` implements 80/90/100% thresholds with dedupe and
hysteresis. It resolves recipients from `mailbox_access`:

```
mailbox_access rows on production ......... 0
mailbox_quota_events rows on production ... 0     (no threshold has ever fired)
tenant_admin users on production .......... 18    (resolvable the whole time)
mailboxes ≥ 75% of quota .................. 4     (one at 100%, mail bouncing)
```

Every candidate mailbox hits the `skipped` branch at `quota-notifications.ts:107`. The feature
was wired to a table that is empty platform-wide, so the *only* branch that has ever executed
in production is the one that does nothing.

Its designated "safety net" — the `mail-mailbox-over-quota` SLO rule (`monitoring/rules.ts:590`)
— is `max(platform_mail_mailboxes_over_quota) > $T` with `subjectLabels: []`. It reads a single
**global counter** (`shared/metrics.ts:133`). There is no mailbox identity in the metric, so the
alert is structurally incapable of naming the mailbox, the tenant, or the contact. And a
mailbox filling up is a **tenant billing/capacity event**, not a platform service-level
objective; it does not belong in the SLO evaluator at all.

### 1.7 37 of 53 categories have never fired

Only 16 categories appear in `notification_deliveries`. The rest are untested in production —
several (`admin.node_down`, `admin.backup_failed`, `admin.wal_archive_failing`) are exactly the
ones an operator most needs to work on the day they finally fire.

### 1.8 UI surfaces are thin

- **The admin panel has no notification inbox.** `/platform/notifications` is the *settings*
  page (Sources · Providers · Templates · Delivery Log). The only place an admin reads
  notifications is the bell dropdown, which renders `{title}` and `{message}` and nothing else
  (`NotificationDropdown.tsx:120-121`).
- **No platform-wide mailbox quota view.** Mailbox usage appears only inside a single tenant's
  detail page (`TenantDetail.tsx:1153`, `EmailAccountsTab.tsx:169`), so answering "which mailbox
  is full?" means opening every tenant in turn.
- The tenant Notifications page shows title, message, relative time and a `resourceType` chip —
  but no link to the object, no severity, and no "what to do".

---

## 2. Design

### 2.1 Three audiences, not two

`audience` exists on every category (`categories/seed.ts:51`) and is used **only** for sorting
and filtering in the admin UI. It never shapes recipients, content, or channels. Replace the
two-value field with an enforced three-value one:

| audience | who | cares about | delivered via |
|---|---|---|---|
| `platform_admin` | fleet operator | which **tenant**, which **node/subsystem**, aggregate scale, remediation | admin inbox + email + ntfy |
| `tenant_admin` | customer's account admin | their tenant, their object, cost/action to them | tenant panel + email to `primary_email`/`secondary_email`, addressed by `contact_name` |
| `mailbox_user` | end user of a mailbox, **has no platform account** | their own mailbox only | **email to the mailbox address itself** |

`mailbox_user` is the missing audience and the direct cause of §1.6: a mailbox owner is not a
platform user, so no user-id-based recipient resolution can ever reach them. They are reachable
only by mailing the mailbox.

**Audience drives recipient resolution.** The dispatcher derives scope from the category's
declared audience instead of trusting a scope the caller passes. A `tenant_admin` category
cannot be delivered to platform staff by a careless call site, and platform internals (node
names, pod names, cluster topology) can be statically barred from tenant-facing templates.

**One event, up to three messages.** A single occurrence fans out into per-audience renders that
differ in content *and* channel. For `mailbox.quota_threshold` at 90%:

- → *mailbox_user* (email to the mailbox): "Your mailbox `user@example.test` is 90% full
  (1350 of 1500 MB). Delete messages, or ask your administrator to increase the quota."
- → *tenant_admin* (panel + email to the contact): "Hi Alex — mailbox `user@example.test` is
  90% full (1350 / 1500 MB). Two other mailboxes on Example Ltd are above 80%. Increase quota →"
- → *platform_admin* (inbox, aggregated, only at 100% or fleet threshold): "3 mailboxes over
  quota across 2 tenants — Example Ltd (`user@example.test`, 100%) … View mailbox quotas →"

### 2.2 The content standard

Every notification must answer five questions. This is enforced structurally, not by review.

| # | question | fields |
|---|---|---|
| 1 | **Who is this about?** | `tenantName` + `contactName` (tenant-facing) · `tenantLabel` (admin-facing) |
| 2 | **What object?** | `subsystem` (mail, tls, dns, backup, compute, billing, security) + `objectType` + `objectLabel` |
| 3 | **What happened?** | `value`, `threshold`, `reason` |
| 4 | **When?** | `occurredAt`, rendered in the recipient's locale — **never a raw ISO string** (production currently mails customers `2026-09-21T00:00:00.000Z`) |
| 5 | **What now?** | `actionText` + `actionUrl` deep link into the correct panel |

Implement as a **`NotificationEnvelope`**: a typed base that every payload extends, populated
**centrally in the dispatcher** from `tenantId` + category metadata — not by each call site.
Identity cannot then be forgotten by an emitter, which is how all 16 of the
identity-free categories in §1.3 came to exist.

### 2.3 Robustness — a missing variable must never mean silence

This is the core defect: the system's failure mode is *silence*, and silence is
indistinguishable from "nothing happened".

1. **Rendering never throws.** Drop `strict: true`. A missing variable renders a neutral
   marker (`—`) and the delivery *proceeds*.
2. **Degradation is recorded and visible.** New `notification_deliveries.degraded_vars`
   column, a `platform_notification_degraded_total` metric, and a "needs data" filter in the
   Delivery Log. A notification that went out thin is a *bug report*, not a silent success.
3. **Contract violations fail at CI, not at runtime.** The audit built for this plan ships as
   `scripts/ci-notification-variable-contract.sh`: the build fails when a template references a
   variable no emitter supplies, or an emitter supplies one no template reads. This is the guard
   that would have caught `nextBillingAt` vs `newExpiresAt` before release.
4. **Boot self-test.** At startup, render every seeded template against a synthetic payload
   derived from its declared `variablesSchema`. Operators can edit templates at runtime, so CI
   alone cannot cover this.
5. **The template editor validates on save.** `PATCH /admin/notifications/templates/:id`
   rejects a body referencing variables the category does not declare, listing them.
6. **Envelope fallback.** If a template is missing or unrenderable *entirely*, fall back to a
   generic render of the five standard fields rather than dropping the message. A degraded
   delivery always beats no delivery.
7. **Fix the transport.** Self-heal a default notification provider against the in-cluster
   Stalwart (the `email-stalwart-master` channel already exists), warn in the admin UI when no
   default provider is configured, and check at startup. This alone recovers the 85 DLQ'd
   admin emails.

### 2.4 Retire the SLO mailbox rule

Delete `mail-mailbox-over-quota` from `monitoring/rules.ts` and the
`platform_mail_mailboxes_over_quota` gauge. Replace with:

- `mailbox.quota_threshold` — **tenant_admin** + **mailbox_user**, at 80 / 90 / 99%.
- `mailbox.quota_exceeded` — same audiences, at 100%, plus a **platform_admin** notification
  that names every affected mailbox, tenant and contact, linking to the new admin view.

Thresholds move to **80 / 90 / 99 / 100**: a warning at 99% arrives while the customer can still
act; at 100% mail is already bouncing.

---

## 3. Per-category remediation

All 53 categories, with the required identity fields each gains. `BROKEN` = drops deliveries
today · `LOSSY` = discards supplied data · `GENERIC` = no identifying data at all.

### 3.1 Tenant-facing (24)

| category | state | must additionally carry |
|---|---|---|
| `subscription.renewed` | **BROKEN** | rename `nextBillingAt`→`newExpiresAt`; + plan name, formatted date, amount |
| `tasks.scheduled_failure` | **BROKEN** | no emitter — add one, or delete the category |
| `tenant.custom_deployment_rolled_back` | **BROKEN** | supply `panelUrl` |
| `legacy.{info,warning,error,success}` | **BROKEN** | delete — migrate all 9 call sites to real categories |
| `subscription.changed` | LOSSY + GENERIC | render `oldPlanName`→`newPlanName`, effective date |
| `subscription.expiry_warning` | LOSSY | render `daysUntilExpiry`; format `expiresAt` |
| `tls.certificate_failed` / `_fallback` | LOSSY | render `expiresAt`; + retry time, action link |
| `tls.certificate_issued` | LOSSY | drop stray `errorMessage`; + expiry date |
| `tenant.email_quota_exceeded` | LOSSY | render `percent` |
| `security.suspicious_activity` | LOSSY | render `userAgent`; + location, "was this you?" action |
| `security.password_reset` / `_changed` | GENERIC | account email, time, IP, revoke-sessions link |
| `tenant.suspended`/`restored`/`archived`/`deleted` | GENERIC | tenant name, **reason**, effective date, contact, appeal path |
| `tenant.email_quota_warning`, `tenant.bandwidth_*`, `account.sub_account_added` | ok | + envelope (contact name, action link) |
| **new** `mailbox.quota_threshold` / `mailbox.quota_exceeded` | — | mailbox, tenant, used/quota, %, action |

### 3.2 Platform-admin-facing (29)

All 29 gain the envelope — `tenantLabel`, `subsystem`, `occurredAt`, `actionUrl` — so every
admin alert states which tenant and which subsystem it concerns and links to the object.

| category | state | must additionally carry |
|---|---|---|
| `admin.slo_alert_{warning,critical}` | LOSSY | render `ruleId`, `severity`; use `subjectLabels` to build a deep link |
| `admin.slo_alert_resolved` | LOSSY | render `description`, `value`, duration-of-incident |
| `admin.tenant_pod_oom` | LOSSY | render `restartCount` |
| 26 others | ok | envelope only |

### 3.3 Dead categories

37 of 53 have never fired. Each is either (a) wired but untriggered — needs an integration test
that forces it, or (b) unreachable — delete. Triage individually; shipping a category that has
never once rendered is how `nextBillingAt` survived to production.

---

## 4. UI surfaces

### 4.1 Admin panel

| surface | status | work |
|---|---|---|
| **Notification inbox** | **missing entirely** | new page: severity, subsystem chip, tenant chip, object deep link; filters by audience/subsystem/tenant/severity/unread; bulk mark-read; "why did I get this" → category |
| **Mail → Mailbox quotas** | **missing entirely** | platform-wide table of mailboxes by % used, sortable, with tenant, contact, last-notified-at and a quota-edit action — the surface that answers "which mailbox?" |
| Bell dropdown | title+message only | severity colour, subsystem chip, tenant, relative time, link |
| Tenant detail → Notifications tab | missing | what this tenant was told, and when — support's first question |
| Delivery Log | exists | add `degraded_vars` column + "needs data" filter + resend |
| Sources (categories) | exists | show 3-way audience, last-fired, 30-day volume; flag never-fired |
| Providers | exists | warn loudly when no default provider exists (85 DLQ'd emails) |

### 4.2 Tenant panel

| surface | work |
|---|---|
| Notifications page | subsystem + severity chips, deep link to the object, explicit "what to do" line |
| Dashboard | actionable-items strip (quota, expiry, cert failures) instead of burying them in a list |
| Email page | per-mailbox quota bar + "request increase" action |
| Notification preferences | group by the 3-way audience; show which channel each category will use |

---

## 5. Phasing

| phase | scope | outcome |
|---|---|---|
| **1 — stop the silence** | §2.3 robustness (non-throwing render, `degraded_vars`, CI contract guard, boot self-test, default provider self-heal) | no notification is ever lost to a missing variable again; 85 DLQ'd emails start flowing |
| **2 — mailbox quota chain** | tenant_admin + mailbox_user recipients, 80/90/99/100, retire the SLO rule, admin mailbox-quota view | the reported bug is fixed end-to-end, with identity |
| **3 — envelope + identity** | `NotificationEnvelope`, central population, contact name, real `platformName`, formatted dates; fix all 18 mismatches | every notification answers the five questions |
| **4 — audience enforcement** | 3-way audience drives recipients + channels + content; per-audience templates | admin vs tenant vs mailbox differ in content *and* delivery |
| **5 — UI surfaces** | admin inbox, tenant detail tab, tenant panel upgrades | notifications become navigable and actionable |
| **6 — legacy retirement** | migrate 9 `notifyUser` call sites, delete `legacy.*`, triage 37 dead categories | one notification system, fully audited |

## 6. Guards this work must leave behind

1. `ci-notification-variable-contract.sh` — payload keys ↔ template variables, both directions.
2. Boot self-test rendering every template against its declared schema.
3. Extend `ci-notification-template-coverage.sh` to assert every category declares a
   three-way audience and that tenant-facing templates reference no platform-internal variable.
4. A test asserting the renderer is **not** in strict mode, with the `nextBillingAt` incident
   named — so the "fix" of re-enabling strict mode cannot silently return.
5. An integration scenario that fills a mailbox past 80/90/99/100 and asserts a real message
   arrives at the mailbox, the tenant contact, and the admin inbox.
