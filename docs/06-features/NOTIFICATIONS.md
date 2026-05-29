# Notifications

Operator runbook for the platform notification system. Covers the
operator mental model, how to configure providers, what each Source
means, how the dispatcher decides whether to deliver, and what to look
for in the delivery log when something looks off.

For the implementation reference (schemas, modules, migrations) see
the Phase 1–6 commits on `main`; this document focuses on the
operator surface.

## Mental model — Sources × Providers × Templates

Three orthogonal things, configured on three tabs of
`/platform/notifications` in the admin panel:

```
Sources           — what TRIGGERS a notification
Providers         — what TRANSPORT delivers it
Templates         — what BODY the recipient sees
```

| Layer | DB table | Default seeding | Operator-editable |
|-------|----------|-----------------|-------------------|
| **Source** | `notification_categories` | Seeded at boot from `categories/seed.ts` (22 entries) | default channels, default severity, rate limit, active flag, **Phase 5**: per-Source email provider override |
| **Provider** | `notification_providers` | None — operator adds them | Full CRUD via the Providers tab |
| **Template** | `notification_templates` (+ `_versions`) | Seeded at boot, one per (source × channel × locale) | Subject + body via the editor; restoring the seed reverts your edits |
| **Delivery** | `notification_deliveries` | Written by the dispatcher | Read-only audit log; the only operator action is "Retry" on `failed` / `dlq` rows |

## Setting up your first provider

The dispatcher refuses to send email until **one** provider has
`isDefault = true` and `enabled = true` for the email channel. Two
provider-type paths:

### Option A — Stalwart in-cluster (recommended)

Uses the platform's own Stalwart mail server. The operator picks
**a real sender mailbox** they create on Stalwart, and the worker
authenticates as the platform master account at send time.

1. **Create the sender mailbox on Stalwart.** Sign in to Bulwark
   admin (or the Stalwart admin UI) and create a normal user account
   like `notifications@<mail-apex>`. Give it any password — the
   platform doesn't read it. The mailbox needs to **exist** but
   doesn't need to be read; you can lock IMAP access if you want.
2. **Add the provider.** Admin panel → Notifications → Providers →
   "Add provider" → pick **Stalwart (in-cluster)**.
   - **Name** — anything descriptive, e.g. `Platform notifications`.
   - **SMTP host / port / TLS** — pre-filled with the in-cluster
     defaults (`stalwart-mail.mail.svc.cluster.local:465` SMTPS).
     Leave them as-is.
   - **From address** — the mailbox you created in step 1.
   - **From name** — optional friendly display name shown in
     recipients' mail clients.
   - **No auth username, no auth password.** The form hides those
     fields when this provider type is selected. The worker reads
     credentials from the K8s Secret `mail/mail-secrets`
     (`STALWART_MASTER_USER` + `STALWART_MASTER_PASSWORD`) at send
     time; these are the same keys Bulwark uses for its impersonation
     flow.
   - Tick **Default for email**.
3. **Send a test.** Use the "Test" button on the row. The worker
   sends a one-line message via this provider to whatever address
   you supply; the row's last-test column flips to **success** or
   **failed**. A failed test typically points at a misconfigured
   sender mailbox (doesn't exist) or master credentials missing from
   `mail/mail-secrets`.

> The platform never auto-provisions the sender mailbox. This is
> deliberate — the master account is enough authority to send as any
> Stalwart user, and silently creating mailboxes from automation
> would weaken that boundary. The
> [2026-05-28 spike memory](../../.claude/projects/.../memory/project_stalwart_sender_restrictions_2026_05_28.md)
> has the receipts.

### Option B — External SMTP provider

For Postmark, Brevo, Mailjet, Mailgun EU, or any generic
SMTP-accepting service.

1. **Create an API key (or SMTP user)** on the provider's dashboard.
   For SaaS providers this is usually under "SMTP credentials" or
   "API keys" → "SMTP".
2. **Add the provider.** Admin panel → Notifications → Providers →
   "Add provider" → pick the right vendor type.
   - **Name**, **From address**, **From name** as above.
   - **Auth username** — usually `apikey` (Postmark, Brevo, Mailjet,
     Mailgun) or the actual SMTP user the vendor issued.
   - **Auth password** — the secret. Stored encrypted with
     `PLATFORM_ENCRYPTION_KEY` (same key used for tenant SMTP creds);
     never written to logs; never returned by the GET endpoint.
   - **SMTP host/port/TLS** — pre-filled with the vendor's default;
     change only if the vendor instructed you to.
3. **Test** the provider before flipping the default. A failed test
   row carries the SMTP server's error verbatim in `lastTestError`.

You can have multiple providers configured at once; only the one with
`isDefault = true` is used unless a Source overrides it (Phase 5).

## Per-Source provider routing (Phase 5)

Each Source can override the default email provider via the
**Send Email via Provider** dropdown in the Source editor. Use this
to route a particular event class through a different transport
(e.g. send `security.password_changed` through Postmark for
deliverability, keep the bulk of `tasks.scheduled_failure` flowing
through Stalwart).

Security semantic: when an override is set **and** the referenced
provider is **disabled**, the dispatcher returns no provider — the
worker marks the delivery `failed` with
`override_provider_unavailable`. We deliberately do not fall through
to the default in that case: disabling a provider is the operator's
tool to stop traffic through a compromised or quarantined endpoint,
and silently rerouting would subvert that intent. To revert a Source
to using the default, clear the dropdown back to the placeholder
option.

## Sources reference

22 Sources seeded at boot. **Mandatory** sources cannot be opted out
on `in_app` + `email` channels — the dispatcher enforces hard-on
even when a user has disabled the channel in their preferences. The
operator can still re-route them via per-Source provider override.

### Tenant-facing (audience: `tenant`)

| Source ID | Severity | Mandatory | Trigger |
|-----------|----------|-----------|---------|
| `security.password_reset` | warning | ★ | Tenant user requests a password reset |
| `security.password_changed` | info | ★ | Tenant user's password is changed |
| `security.suspicious_activity` | warning | ★ (rate-limit 5/h) | Repeated login failures, WAF events |
| `subscription.expiry_warning` | warning | ★ | Daily scheduler: 7 / 3 / 1 days before `subscription_expires_at` |
| `subscription.renewed` | info | | `subscription_expires_at` advances past its previous value |
| `subscription.changed` | info | | `plan_id` changes on a tenant |
| `account.sub_account_added` | info | | (Wiring pending — Phase 6E candidate.) |
| `tasks.scheduled_failure` | warning | (rate-limit 3/h) | (Wiring pending — Phase 6E candidate.) |
| `tenant.suspended` | error | ★ | ADR-033 transition `active → suspended` |
| `tenant.restored` | success | | ADR-033 transition `suspended → active` |
| `tenant.archived` | error | ★ | ADR-033 transition `* → archived` |
| `tenant.deleted` | critical | ★ | ADR-033 transition `* → deleted` |

For the tenant lifecycle transitions, the admin sees a **"Notify
tenant"** checkbox on every action button — default ON. Untick it to
suppress the tenant notification while still applying the transition
(e.g. emergency archival the operator wants to follow up by phone).

### Admin-facing (audience: `admin`)

| Source ID | Severity | Wired in Phase 6A | Producer |
|-----------|----------|---|---|
| `admin.cert_expiring` | warning | ✓ | `certificates/cert-reconciler.ts` — fires when `expiresAt - now ≤ 15 days`, dedupe keyed `cert-expiring:<domain>:<expiry-date>` |
| `admin.cert_renewal_failed` | error | ✓ | `certificates/cert-reconciler.ts` — fires in the catch branch on sync failure |
| `admin.backup_failed` | error | ✓ | `backup-health/scheduler.ts` — fires when a watched Job enters Failed state |
| `admin.backup_target_unreachable` | warning (rate-limit 1/12h) | ✓ | `backup-config/service.ts:testConnection` — fires on failed test, dedupe keyed `(target × day)` |
| `admin.node_down` | critical | ✓ | `node-health/scheduler.ts` — fires when `ready=false` AND severity is critical, dedupe keyed `(node × day)` |
| `admin.security_hardening_drift` | warning | — | Producer not wired yet; needs a detector that reads security-probe DaemonSet snapshots and emits when CIS findings transition from passing → failing. |

## Per-user preferences

Tenants and admins manage their own per-Source × per-channel
preferences at:

- **Tenant panel** → `/notification-preferences`
- **Admin panel** → user profile menu (planned; not surfaced yet)

The default preference for any user on any (source, channel) is taken
from `notification_categories.default_channels` and can be overridden
explicitly. Mandatory sources display a lock icon — the checkbox is
disabled because the dispatcher enforces hard-on regardless.

Settings include quiet hours (HH:MM in the user's locale; critical
severity bypasses), timezone, digest mode (immediate / hourly /
daily — only immediate honoured today; hourly + daily are accepted
shape but flush-as-immediate until Phase 7).

## Delivery log — troubleshooting

`/platform/notifications` → **Delivery Log** tab. Filters: channel,
status, category, tenant, since. Per-row Retry button (visible on
`failed` and `dlq` email rows only).

### Statuses

| Status | Meaning | Operator action |
|--------|---------|-----------------|
| `queued` | Dispatcher wrote the row; pg-boss has the job. Worker hasn't picked it up yet. | None — should advance within seconds. |
| `sending` | Worker has the job, mid-SMTP. | None — temporary. Stuck `sending` > 10 min indicates a hung connection; check platform-api logs. |
| `sent` | Worker received a 250 from the SMTP server. | None — successful delivery. (We do not track DSN bounces yet.) |
| `failed` | One delivery attempt failed; `attempt < maxAttempts`. The dispatcher will re-enqueue with the configured backoff. | None unless `attempt` reaches 5+ — check `lastError` and consider Retry. |
| `dlq` | Six attempts failed; delivery is dead-lettered. No further automatic retries. | Investigate `lastError`. Hit Retry once the upstream issue is fixed. |
| `skipped` | Delivery was never attempted. `lastError` carries the reason. | See "Skip reasons" below. |
| `rate_limited` | The Source's per-(user, category) rate limit was exhausted. | Usually benign — Source is talking too much. Raise the rate limit if expected. |
| `muted` | User opted out (or quiet hours active for non-critical severity). | None — normal preference behaviour. |

### Skip reasons (`lastError`)

| Reason | Meaning | Fix |
|--------|---------|-----|
| `template_not_found` | No active template for (source, channel, locale). | Add the template or restore the seed. |
| `recipient_email_missing` | User row has no email address. | Set the user's email. |
| `user_id_missing` | Delivery row userId is null. | Should never happen for category-scoped events; report as a bug. |
| `platform_encryption_key_missing` | `PLATFORM_ENCRYPTION_KEY` env var not set. | Set it on the platform-api Deployment. |
| `no_default_notification_provider` | No provider has `isDefault=true` for email. | Configure a provider (see "Setting up your first provider"). |
| `override_provider_unavailable` | Source has a per-Source override, but the provider is disabled or missing. | Re-enable the provider or clear the override on the Source. |
| `provider_smtp_host_missing` | Provider row has NULL smtp_host. | Edit the provider and set smtp_host. |
| `provider_password_decrypt_failed` | The stored ciphertext can't be decrypted with the current PLATFORM_ENCRYPTION_KEY. | The key was rotated without re-encrypting providers. Edit the provider and re-enter the password. |
| `stalwart_master_credentials_unavailable` | `mail/mail-secrets` Secret is missing `STALWART_MASTER_USER` or `STALWART_MASTER_PASSWORD`, or the platform-api can't read the Secret. | Verify the Secret exists and the platform-api ServiceAccount has RBAC to read it. |

### Retention + GDPR

`notification_deliveries` rows are purged daily after **30 days**.
The dispatcher's dedupe-key check uses the same 30-day window — we
never dedupe against a row that's been purged.

The `recipient_hash` + `content_hash` design means we **never** store
the raw email body or recipient address in the delivery row. Right-
to-erasure (`users` deletion) cascades through the `eraseUserNotifications`
helper invoked from the admin-user-delete path. Right-of-access
export is available via `retention/gdpr-export.ts` but not yet wired
into the tenant-bundles GDPR export flow.

## Operator alerts (Phase 6A summary)

Five admin-facing Sources are wired to producers as of 2026-05-29:

| Source | Lights up when… |
|--------|-----------------|
| `admin.cert_expiring` | a domain certificate has ≤ 15 days until renewal |
| `admin.cert_renewal_failed` | the cert reconciler hits an error syncing one domain |
| `admin.backup_failed` | a watched backup Job enters Failed state |
| `admin.backup_target_unreachable` | a backup target connection test fails |
| `admin.node_down` | a cluster node goes NotReady at critical severity |

For each, the producer uses a stable dedupe key (typically
`<event>:<resource>:<day>`) so the dispatcher silently suppresses
repeated emits during the day. Re-fires happen naturally the next
day if the condition persists.

`admin.security_hardening_drift` is seeded but **no producer
calls it yet** — the detector would need to read the security-probe
DaemonSet snapshots and fire on transitions from passing → failing.
Filed as a Phase 6+ candidate.

## Schema reference

```
notification_categories
notification_templates       + _versions
notification_deliveries      (+ event_variables, dedupe_key)
notification_providers       (Phase 3B)
user_notification_preferences
user_notification_settings
notification_rate_limit_buckets
```

Migrations 0035–0045. Tables seeded at boot (`categories/seed.ts`,
`templates/seed-loader.ts`); providers are operator-managed only.

## Related

- ADR-033 — Tenant lifecycle hook registry (the path `tenant.suspended`
  etc. travel through).
- ADR-040 — SYSTEM tenant + reserved hostnames (relevant for the
  `notifications@<apex>` sender restriction).
- Spike memo `project_stalwart_sender_restrictions_2026_05_28.md` — why
  the master account can authenticate but cannot use arbitrary
  `MAIL FROM`, which is the design reason for the dedicated Stalwart
  Provider path described above.
