---
verified: 2026.6.7
---

# Platform settings

The **Platform Settings** sidebar group is where you configure the
platform as a product — its identity, plans, limits, integrations,
notifications, and how it updates itself. You touch most of these once and
forget them. This chapter walks each page; some require `super_admin`.

| Page | What it configures |
|------|--------------------|
| **Updates** | Image-update strategy, version check, update now. |
| **Upgrades** | Guarded platform version upgrades (super_admin). |
| **Identity** | Platform name, panel URLs, support contacts. |
| **Hosting Plans** | Plans and resource limits. → [Plans & subscriptions](plans-and-subscriptions.md) |
| **Limits & Regional** | API rate limit, timezone, currency. |
| **DNS Providers** | DNS provider groups + servers. → [Domains & DNS](domains-and-dns.md) |
| **Integrations** | Embedded-service URLs (Longhorn, …). |
| **AI Providers** | AI model providers + keys. |
| **Tenant Lifecycle Hooks** | Lifecycle hook health + controls. |
| **Notifications** | Notification sources, providers, templates, log. |
| **Export / Import** | Configuration export/import (super_admin). |

## Updates

**Platform → Updates** shows the running version vs the latest available,
with an **Auto-Update** toggle and **Check for Updates** / **Update Now**
buttons, plus a **Deployed Images** modal (every component's image, tag,
ready-count). On environments where image updates are managed externally
(Flux Image Automation), the toggle and Update Now button are hidden and
you see a "managed by Flux" badge instead.

## Upgrades (super_admin)

**Platform → Upgrades** is the guarded path for moving the whole platform
to a new version. It shows the version spine (installed → available), runs
live **pre-flight gates** (pass / warn / fail), previews **host
migrations**, and gates **Apply** on pre-flight passing. After applying, a
**post-flight** panel tracks convergence to the new version, and there's a
**roll back the last upgrade** action.

!!! warning "Pre-flight failures block the upgrade"
    Apply stays disabled while any pre-flight gate is failing. Resolve the
    blocking checks first — they exist to stop an upgrade that would break
    the cluster. The operator runbook is in the
    [Operator guide](../operator/updates-and-releases.md).

## Identity — name, panel URLs, support

**Platform → Identity** sets the platform's public identity:

- **Platform name** — shown across the panels.
- **Admin Panel URL** and **Tenant Panel URL** — the canonical URLs. The
  Tenant Panel URL is what **Login as Tenant** uses; if it's blank,
  impersonation can't open the tenant panel.
- **Support email** and **support URL**.

A URL-health indicator flags any of these that aren't reachable. Saving
sends a partial update, so it won't disturb Limits or other settings.

## Limits & Regional

**Platform → Limits & Regional** sets the **API rate limit**, the default
**timezone**, and the **currency** (which is what plan prices and the AI
budget are displayed in everywhere else).

## DNS Providers

**Platform → DNS Providers** configures the DNS provider groups and
servers (PowerDNS / BIND) that back Primary and Secondary DNS modes.
Covered in full in [Domains & DNS](domains-and-dns.md).

## Integrations — platform URLs

**Platform → Integrations** holds the operator-editable URLs the admin
panel uses to embed or link to adjacent services — for example the
**Longhorn Dashboard URL** that the [Storage page](nodes-and-storage.md)
opens. Leave a field blank to fall back to the built-in default; the page
shows whether each value is the default or your override, with a reset.

!!! note "These URLs feed the reserved-hostname set"
    Some platform URLs (Longhorn, and the mail/webmail URLs set in
    [Email → Settings](email.md)) are part of the reserved-hostname list
    that blocks tenants from claiming internal subdomains. Editing them
    updates that protection automatically. See [Domains & DNS](domains-and-dns.md).

## AI Providers

**Platform → AI Providers** registers the AI model providers that power the
tenant panel's AI-assisted file editing. Add a provider — **Anthropic**,
**OpenAI**, or an **OpenAI-compatible** custom endpoint (e.g. a self-hosted
Ollama) — and one or more models (with API keys). Each model can be
enabled, disabled, edited, or deleted. The per-tenant *spend cap* for AI
editing is set separately, on each [plan](plans-and-subscriptions.md).
There is no AI feature beyond this file-editing assist — no AI website
builder.

## Tenant Lifecycle Hooks

**Platform → Tenant Lifecycle Hooks** is the operator surface for the hook
registry that runs every tenant transition (suspend, archive, delete, …).
It shows per-hook **success rate** over recent transitions, a **recent
transitions** tree, and controls to **Retry** a failed hook run and
**reset a hook's circuit breaker** when it's tripped. The
[Dashboard](index.md) links here when a transition fails. The lifecycle
itself is described in [Tenants](tenants.md).

## Notifications

**Platform → Notifications** configures how and when the platform notifies
*you*. The model is **Sources × Providers**, across four tabs:

- **Sources** — what triggers a notification (one entry per event type),
  with its default channels and rate limit. (Subscription-expiry reminders
  are configured here — see [Plans & subscriptions](plans-and-subscriptions.md).)
- **Providers** — the transport endpoints that deliver them (today: SMTP
  relays).
- **Templates** — operator-editable Handlebars templates per (source,
  channel, locale).
- **Delivery Log** — per-channel delivery outcomes for audit and triage.

## Export / Import (super_admin)

**Platform → Export / Import** exports the platform configuration to a JSON
file you can download, and imports a previously exported file. Use it to
seed a new environment or to snapshot configuration before a risky change.

## Cluster-level flags (not in the panel)

A few operational flags live in the cluster's `platform-config`
ConfigMap rather than as panel toggles — most notably
**`node-terminal-enabled`**, which controls whether the
[node terminal](nodes-and-storage.md) is available (on in dev/staging,
off in production by default). Changing these is an operator task; see the
[Operator guide](../operator/nodes-and-cluster.md).
