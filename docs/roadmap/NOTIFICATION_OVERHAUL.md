# Notification System Overhaul

> **Status:** ALL NINE PHASES IMPLEMENTED (branch `feat/notification-overhaul`, merged to `development`) (branch `feat/notification-overhaul`, merged to `development`)
> · **Author:** platform · **Date:** 2026-09-14, implementation 2026-09-15
>
> A plan to make platform notifications *useful*. Today a notification tells you that
> something happened; it does not reliably tell you **to whom**, **about what**, **how bad**,
> or **what to do** — and a meaningful share of them are never delivered at all.
>
> Every number below was measured against the live production cluster on 2026-09-14, not
> inferred from the source. Identifiers are redacted (`example.test`) per public-repo policy.

---

## 1. Evidence

### 1.1 Delivery health — and a withdrawn claim

An earlier draft of this document reported email delivery as **57% failing**, citing 85
dead-lettered rows labelled `no_default_notification_provider`. **That was wrong** — it read a
lifetime counter as a current state.

There **is** a default email provider (`is_default=t`, `enabled=t`, last test `success`). The
last dead-letter was **2026-09-06**. Current window (since 2026-09-07):

| channel | sent | dlq | skipped |
|---|---|---|---|
| in_app | 74 | 0 | 0 |
| email | 65 | 0 | **9** |
| ntfy | 74 | 0 | 0 |

The provider is not a defect and nothing in this plan is justified by it. What survives is the
render failure — **9 skipped emails in the current window, still occurring today**.

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

### 1.5 There are THREE parallel notification systems

| | dispatcher | `notifyUser()` | **raw insert** |
|---|---|---|---|
| call sites | 53 categories | 9 | **15 modules** |
| template | yes | no | no |
| email / push | yes | **no** | **no** |
| preferences / rate limit | yes | **no** | **no** |
| delivery audit | yes | **no** | **no** |
| appears in Sources UI | yes | as `legacy.*` | **no — category is NULL** |

`notifications.category_id` is nullable with no default (`schema.ts:847`), so a raw
`db.insert(notifications)` lands a row the dispatcher never sees. **Proven live:** the two
"Domain not yet verified" rows on production carry `category_id = NULL`.

The third path carries the most consequential events on the platform — **cluster storage
capacity** (80% warn / 95% critical, computed every 5 min across every Longhorn node), node
subsystem health, node health, namespace-integrity violations, stuck PITR restores, image cache
pressure, and the platform-upgrade `abort-recommended` signal. An operator learns their cluster
is 95% full by happening to open the panel.

**67 of ~220** in-app rows are `legacy.*` from the second path, with zero delivery rows. Those
are the operational tenant-facing events — IMAPSync, email enabled for a domain, mailbox limit,
DKIM rotation, mailbox quota. **None has ever reached a tenant by email.**

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

### 2.0 The root cause: there is no routing policy

**All 53 categories ship with all three channels enabled.** No exception. Only 14 carry any
rate limit. Channel selection is 53 independent guesses, and the result is that everything is
broadcast everywhere.

Consequences, measured over 14 days:

- **75% of all notification traffic is SLO alerts.** The single largest source is
  `admin.slo_alert_resolved` at **130 deliveries** — each one emailed *and* pushed to say
  something stopped being broken.
- **ntfy is a single platform-wide operator broadcast topic**, emitted once per event with no
  per-user leg (`dispatcher/dispatch.ts:225`). Because every tenant category has ntfy on,
  **tenant billing events are pushed to the operator topic** — 10 `subscription.renewed`
  pushes. Noise for the operator, and tenant data on a shared channel.

Replace per-category guesswork with derivation from two declared properties.

#### Audience is a SET, not a value

An event declares one or more **bindings** — `(audience, class, threshold)` — and channels are
*derived* from each binding, never hand-set. The proof that this was the missing abstraction:
two features built weeks apart each got exactly one audience, and they chose opposite ones.

| event | implemented in | tenant admin | platform admin | fired in prod |
|---|---|---|---|---|
| **Storage quota** (warn 90 / crit 95) | `metrics/tenant-saturation.ts` | **never told** | notified | never |
| **Email sending limit** (hour + day) | `mail-events/thresholds.ts` | notified | **never told** | never |
| **Mailbox quota** (80/90/100) | `mail-stats/quota-notifications.ts` | **never told** | an unnamed global counter | **never — 0 events, ever** |

The tenant whose disk is filling is never warned; the operator never learns a tenant is
saturating the sending limit. Neither is a bug inside either feature — both are the same
missing question, *"who else needs to know?"*, which a single-valued `audience` field cannot
even express.

`mailbox.quota` modelled with bindings:

| audience | fires at | class | delivery |
|---|---|---|---|
| `mailbox_user` | 80 / 90 / 99 / 100 | Action | direct mail to the mailbox |
| `tenant_admin` | 80 / 90 / 99 / 100 | Action | panel + email to contact |
| `platform_admin` | **100 only** | Action | inbox + email, **aggregated** across tenants |

#### Audience → available channels

| audience | in_app | email | ntfy | direct mail |
|---|---|---|---|---|
| `platform_admin` | admin panel | staff address | operator topic | — |
| `tenant_admin` | tenant panel | contact address | **barred** | — |
| `mailbox_user` | *no account* | — | — | **to the mailbox** |

ntfy is a single operator broadcast topic (one emit per event, no per-user leg,
`dispatcher/dispatch.ts:225`), so barring it for tenant audiences removes both the noise and
the leak of tenant data onto a shared channel.

#### The channel must outlive the event

**A notification delivered only through the thing it reports on is not a notification.**
"Node finished booting" was routed in-app — to a panel that was unreachable for the whole
outage it describes. Every category declares the **subsystem it reports on**, and the router
excludes the channel that depends on it, guaranteeing at least one independent path:

| reports on | cannot be trusted | primary delivery |
|---|---|---|
| platform/panel availability (node down, rebooting, startup complete, monitoring unreachable) | **in-app** — the panel was down | email + push; in-app is the after-the-fact record |
| mail delivery (mail health degraded, blocklisted, queue backlog) | **email** — the transport is the subject | push + in-app |
| push transport (ntfy unreachable) | **push** | email + in-app |
| everything else | — | class default |

#### Class — six, applied *per binding*

Severity says how loud; class says why the recipient is being told, which decides whether a
message leaves the platform UI. The same event can be Incident for one audience and Action for
another.

| class | meaning | default routing |
|---|---|---|
| **Ambient** | For the record, never actionable, and the reader was there | **in-app only** |
| **Record** | A durable receipt needed later | in-app + email; no push |
| **Action** | Must act or it degrades | in-app + email, escalating; digest-eligible early, push at the final threshold |
| **Incident** | Broken now, someone must respond | all available channels; never digested; bypasses quiet hours |
| **Availability** | The platform's own reachability | **out-of-band always** — the dependent channel is excluded |
| **Security** | Identity, access, account state | in-app + email, **mandatory**; push for operators only |

`admin.slo_alert_resolved` becomes **Ambient**, removing 130 emails and 130 pushes a fortnight.

### 2.0.2 The three missing coverages

**Tenant storage quota.** `tenant-saturation.ts` already computes it at 90/95% and notifies only
the operator. Add: `tenant_admin` Action at 90%, `tenant_admin` Incident at 95%,
`platform_admin` Incident at 95% aggregated by tenant.

**Email sending limit.** `mail-events/thresholds.ts` notifies only the tenant. Add:
`platform_admin` Incident at 100%, aggregated by tenant — a saturated sending limit is the shape
of both a compromised account and a platform-wide deliverability risk.

**Subscription expiry cadence.** The scheduler fires at **7 / 3 / 1 days**, tenant-only
(`expiry-warning-scheduler.ts:50`). Seven days is not enough notice to raise a purchase order.
Change to **weekly for five weeks — 35 / 28 / 21 / 14 / 7** — and add a `platform_admin` binding
that aggregates into one weekly digest line. The dedupe key
(`subscription-expiry:<tenant>:<daysOut>d:<date>`) already has the right shape; it needs the
window list widened and a second binding, not new machinery.

### 2.0.1 Configuration precedence — five layers, highest wins

1. **Class default** — derived from (audience × class); correct for 53 of 53 on day one.
2. **Platform policy** — operator retunes channels, rate limit, digest window, severity.
3. **Tenant policy** — tenant admin routes billing vs technical vs security to different contacts.
4. **User preference** — per-category, per-channel opt-out + quiet hours, bounded by `isMandatory`.
5. **Object mute** — "mute this mailbox / domain / node for 7 days".

Convenience mechanics: **digests** (Ambient + non-final Action roll into one daily summary),
**aggregation** (repeats collapse — "3 mailboxes over quota across 2 tenants"), **quiet hours**
(Incident and Security pass through), and **escalation** (an unacknowledged Action escalates a
level, or to the platform admin when a tenant does not respond).


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

### 2.0.3 Channels are declared objects

ntfy leaked tenant billing events onto the operator topic because the channel had no properties
of its own — it was a string in a per-category list, and the seed gave it to all 53. Adding
Slack, SMS or webhooks to that model repeats the bug exactly. Each channel declares:

- **audiences** — who may route through it at all
- **addressing** — `per_user` | `per_tenant` | `broadcast`. *A broadcast channel may never carry
  tenant-scoped content.* That one rule is the ntfy fix and pre-empts it for every shared Slack
  channel or team webhook added later
- **outOfBand** — whether it survives the platform being unreachable (what Availability routes on)
- **dependsOn** — the subsystem the channel itself needs, which drives the survivability
  exclusion automatically rather than from a hand-maintained list
- **richness** — `full` | `short`; push and SMS need a truncated render, not a clipped email body

| channel | audiences | addressing | out-of-band | depends on | richness |
|---|---|---|---|---|---|
| `in_app` | both | per_user | no | platform API + panel | full |
| `email` | both | per_user | yes | mail subsystem | full |
| `ntfy` | **platform_admin only** | **broadcast** | yes | external push | short |
| `direct_mail` *(new)* | mailbox_user | per_user | yes | mail subsystem | full |
| `webhook` *(future)* | both | per_tenant | yes | external HTTP | full |
| `slack`/`teams` *(future)* | platform_admin | **broadcast** | yes | external HTTP | full |
| `sms` *(future)* | both | per_user | yes | external gateway | **short** |

Effective channels for a binding compose rather than being listed:

```
class defaults ∩ audience's allowed channels ∩ channels admitting that audience
               − channels depending on the failing subsystem ∩ policy overrides
```

Adding a channel becomes one registry row, and no category can acquire a channel wrong for its
audience — which is exactly how all 53 acquired ntfy.

### 2.0.4 What isn't being said at all

A sweep of all 125 backend modules and 76 schedulers/reconcilers, ordered by cost to fix.

**A — detected, announced to nobody.** The condition is already computed and persisted; only the
binding is missing.

| event | detected by | proposed bindings |
|---|---|---|
| **Deployment crash-looping** (CrashLoopBackOff/OOMKilled/ImagePullBackOff) | `deployments/status-reconciler.ts` | tenant_admin Incident · platform_admin Action (aggregated) |
| **Scheduled task failed** (records status + output) | `cron-jobs/scheduler.ts` | tenant_admin Action |
| **Node terminal session opened** (privileged host shell) | `node-terminal/*` | platform_admin Security — every session |
| **DNS apex drift** | `dns-apex-drift/scheduler.ts` | platform_admin Action |
| **WAF autoban activity** | `crowdsec-autoban/scheduler.ts` | platform_admin Ambient — daily digest |
| **Platform update available** | `platform-updates/*` | platform_admin Record |
| **Tenant storage 90/95%** | `metrics/tenant-saturation.ts` | tenant_admin Action / Incident |
| **Sending limit saturated** | `mail-events/thresholds.ts` | platform_admin Incident (aggregated) |

**B — in-app only on the third path.** Already notified, as a category-less row that can never be
emailed, pushed, muted or audited. Promote each to a real category. *Cluster storage capacity
first.*

Cluster storage capacity · node subsystem health · node health · domain verification failed ·
upgrade abort-recommended · PITR/restore stuck · namespace-integrity violation · image cache
pressure · mail principals-sync drift — plus resource-quotas, storage-policy, mail migration and
system-settings. 15 modules.

**C — orphan categories.** Templates on all three channels, nothing emits them:

- `tasks.scheduled_failure` — **no emitter exists anywhere.** The cron scheduler in group A is
  what should fire it.
- `security.suspicious_activity` — the helper *is* written in `events.ts`; **nothing calls it.**
  A new-IP sign-in is detected nowhere.

**D — absent entirely.**

| audience | missing | class |
|---|---|---|
| tenant_admin | Backup completed / failed — *the tenant never learns their backup ran, or didn't* | Record / Incident |
| tenant_admin | Restore completed / failed | Record / Incident |
| tenant_admin | Certificate expiring (operators get this; tenants only get failure) | Action |
| tenant_admin | Plan limit approaching 80% (only "reached" exists — too late to act) | Action |
| tenant_admin | Maintenance window announced / started / finished | Availability |
| tenant_admin | Migration completed / failed | Record |
| tenant_admin | Database or SFTP credential created / rotated | Security |
| mailbox_user | Mailbox created — welcome + connection settings | Record |
| mailbox_user | Mailbox password changed or reset | Security |
| mailbox_user | Forwarding or auto-responder changed | Security |
| mailbox_user | Sign-in from an unrecognised location | Security |
| platform_admin | Admin created, role changed, super_admin granted | Security |
| platform_admin | Failed admin sign-in streak / lockout | Security |
| platform_admin | DR readiness degraded (cluster cannot decrypt its own backups) | Incident |
| platform_admin | External provider unreachable (DNS, mesh VPN, identity) | Availability |
| platform_admin | Orphaned volumes accumulating | Ambient (digest) |
| platform_admin | Signing key or platform certificate expiring | Action |

Groups A and B are ~17 notifications the platform **already has the data for** — bindings, not
detection, which makes them the cheapest meaningful improvement available.

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

## 4. Surfaces

**Tenant problems belong on the tenant, not on a page about the problem.** An earlier draft
proposed a standalone mailbox-quota page; that creates one page per subsystem and makes the
operator remember to visit each.

A **tenant issue** is an open, self-clearing condition — mailbox over quota, storage at 95%,
subscription expiring, certificate failing, sending limit hit — derived from the same threshold
state the notifications fire from, so a banner and a notification can never disagree.

| existing surface | addition |
|---|---|
| **Tenants table** → status column | Beside *Active*, a yellow **"3 issues"** chip (red when any issue is Incident). Sortable + filterable, so "every tenant with a problem" is the existing table with a filter — not a new page |
| **Tenant detail** → top of page | A yellow banner listing every current issue — object, value, age — each linking to the tab that fixes it. Red when any is critical |
| **Tenant detail** → mailbox table | The existing *Used / Quota* column gains a bar and a colour at 80 / 90 / 99. Already the place a quota is edited |
| **Tenant panel** → dashboard | The same issue list, tenant-side, above the fold — the customer sees what the operator sees about them |
| **Tenant panel** → email page | Per-mailbox quota bar + "request increase" |
| **Admin** → notification inbox | The one genuinely new surface. `/platform/notifications` is the *settings* screen; the only place an operator reads a notification is the bell dropdown, which renders title + message and nothing else |
| **Admin** → delivery log | `degraded_vars` column, "needs data" filter, resend |
| **Admin** → sources | Show bindings (audience × class), last fired, 30-day volume; flag the 37 that never fire |

## 4a. Implementation status (2026-09-15)

| phase | state | landed as |
|---|---|---|
| 1 — stop the silence | **done** | `render-for-delivery.ts` (never throws), `degraded_vars` (0111), `platform_notification_degraded_total`, envelope fallback, CI variable-contract guard, 90-day retention ceiling + guard |
| 2 — bindings replace audience | **done** | `routing/classes.ts`, `routing/channel-spec.ts`, `effective-channels.ts`; migration 0112 rewrites `default_channels` for 46 of 53 categories |
| 3 — mailbox quota chain | **done** | 80/90/99/100, tenant-admin + mailbox-owner recipients (`recipient_address`, 0113), aggregated operator view, SLO rule + gauge retired |
| 4 — channel registry | **done** | channels declare audiences / addressing / outOfBand / dependsOn / richness; broadcast channels barred from tenant-scoped content |
| 5 — close the gaps | **done** | tenant storage saturation, operator sending-limit visibility, expiry 35/28/21/14/7 + operator digest |
| 6 — identity everywhere | **done** | `dispatcher/envelope.ts` — tenantName, contactName, real platformName, full userName, formatted `occurredAt`; all 15 contract defects fixed |
| 7 — issues on tenant surfaces | **done** | `tenant-issues/service.ts`, `GET /admin/tenants/issues`, status-column chip, tenant-detail banner |
| 8 — convenience | **done** | quiet hours are class-driven; per-object mutes (mandatory 30-day cap, unmutable Incident/Availability/Security, fail-OPEN lookup); digests that finally honour `digest_mode`, a preference that was stored, displayed and read by nothing; escalation of unread Action notifications to the operator after 48h. Dedupe + rate limits already existed. |
| 9 — retire the other paths | **done** | Both legacy paths are GONE. `notifyUser`/`notifyUsers` deleted, `createNotification` requires a category, the four `legacy.*` categories and their templates removed (migration 0115). ~25 call sites across 20 modules now dispatch through a real category. |

Integration coverage: `scripts/integration-notification-routing-e2e.sh` asserts the
policy as it exists in the DATABASE — ambient categories stay in-app, no tenant category
routes to ntfy, the new categories are seeded, no delivery was dropped for a render
failure, and the tenant-issues endpoint answers.

## 5. Phasing

| phase | scope |
|---|---|
| **1 — stop the silence** | non-throwing render, `degraded_vars`, CI variable-contract guard, boot self-test, envelope fallback |
| **2 — bindings replace audience** | `(audience, class, threshold)` binding set, subsystem-dependency exclusion, channel derivation |
| **3 — mailbox quota chain** | tenant-admin + mailbox-user bindings, 80/90/99/100, retire the SLO rule + global gauge |
| **4 — channel registry** | channels become declared objects (audiences, addressing, out-of-band, dependsOn, richness); ntfy barred for tenants falls out of the model |
| **5 — close the gaps** | tenant storage quota, operator sending-limit visibility, five-week expiry cadence, and catalogue groups A + B — 17 notifications the data already exists for |
| **6 — identity everywhere** | `NotificationEnvelope`, contact-name addressing, real `platformName`, localised dates, all 18 contract defects |
| **7 — issues on tenant surfaces** | issue model, status-column chip, tenant-detail banner, mailbox usage bars, tenant dashboard, operator inbox |
| **8 — convenience** | digests, aggregation, quiet hours, object mute, escalation, tenant contact routing |
| **9 — retire the other two paths** | migrate 9 `notifyUser()` call sites + 15 raw-insert modules, delete `legacy.*`, triage the 37 never-fired categories |

## 6. Guards this work must leave behind

All five are in place (2026-09-15).

| # | guard | kind | runs |
|---|---|---|---|
| 1 | `ci-notification-variable-contract.sh` — payload keys ↔ template variables, both directions | CI guard | every PR |
| 2 | `templates/render-all-seeds.test.ts` — every seeded template RENDERS, with a full payload and with an empty one | unit test | every PR |
| 3 | `ci-notification-template-coverage.sh` — extended: every category declares an audience from the contract enum, and no tenant-facing template references a platform-internal variable | CI guard | every PR |
| 4 | `templates/strict-mode-regression.test.ts` — pins the `subscription.renewed` / `nextBillingAt` incident so "just turn strict mode off" or "drop the fill step" cannot silently restore it | unit test | every PR |
| 5 | `integration-mailbox-quota-notify-e2e.sh` — fills a real 20 MB mailbox with incompressible data and asserts the mailbox OWNER, the TENANT ADMIN and (at 100%) the OPERATOR are all told, then that it does not repeat | integration | when the suite is run against a cluster |

Guard 2 was specified as a boot self-test. A unit test is strictly better
placed: it fails on the PR that introduces the bad template rather than on the
pod that boots with it, and costs nothing at runtime.

Guard 5 is the only one CI cannot give you — every static check can pass while
the chain delivers to nobody, which is exactly the state this feature shipped
in. It needs a live cluster, so it runs with the integration suite rather than
on a PR. The mailbox quota floor was lowered 50 MB → 20 MB to make it cheap
(50 was a round number, not a constraint); the payload is base64 of
`/dev/urandom` because Stalwart compresses at rest and repetitive filler never
moves the threshold — a first attempt pushed 52 MB and the mailbox reported 14.
   arrives at the mailbox, the tenant contact, and the admin inbox.
