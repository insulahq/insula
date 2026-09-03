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
| **Limits & Regional** | API rate limit, retention windows (snapshots, deleted-tenant backups, file-manager recycle bin), timezone, currency. |
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
budget are displayed in everywhere else), plus three retention windows:

| Setting | What it controls |
|---|---|
| **Snapshot Retention** | How long on-server tenant volume snapshots are kept (1–720 hours). |
| **Deleted-Tenant Backup Retention** | Grace window before a deleted tenant's off-site bundles are reaped (1–3650 days). |
| **File Manager Recycle Bin** | How long a tenant's deleted files are recoverable (1–365 days, default 14). |

### File-manager recycle bin

Files a tenant deletes in the file manager move to a recycle bin on **that
tenant's own volume** instead of being erased. They are removed automatically
once this window passes.

!!! warning "Trashed files consume the tenant's quota"

    The bin lives on the tenant's PVC, so deleting a file frees **no** space
    until it expires or the tenant empties the bin. There is deliberately no
    size cap — a size-driven purge would delete one tenant's files because
    another filled the bin — so a longer window means tenants sit closer to
    their quota. The tenant panel shows the bin's size next to their storage
    figure, and every delete dialog offers **Delete permanently** as an opt-in.

Changing this value takes effect immediately; it is not baked into running
tenant pods. Expiry runs from two places: opportunistically while a tenant is
using their file manager, and from a background reconciler every six hours
that covers tenants who deleted something and never came back.

The bin is included in tenant backup bundles, so restoring a bundle also
restores whatever was recoverable at capture time.

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
- **Providers** — the transport endpoints that deliver them: SMTP relays
  for email, and **ntfy push** for phone/desktop push notifications.

!!! tip "Push notifications via ntfy"
    Add a provider of type **ntfy push (topic)**: point it at the public
    [ntfy.sh](https://ntfy.sh) or your own self-hosted ntfy server (any
    reachable URL, in-cluster included), pick a topic, and — for private
    topics — an access token or username/password (stored encrypted).
    Mark it **Default for ntfy**, use **Test** to publish a check message,
    then enable the *ntfy* channel on the Sources you want pushed.
    ntfy is a **topic broadcast**: one message per event for everyone
    subscribed to the topic (it does not appear in per-user notification
    preferences), with priority mapped from the event severity and a
    tap-through link into the admin panel. Anyone who knows a public
    topic's name can subscribe to it — use a private topic (or an
    unguessable name) for anything sensitive.
- **Templates** — operator-editable Handlebars templates per (source,
  channel, locale). Every source ships a template on **every** channel,
  so enabling a channel on a source never leaves it delivering silence.
  The *subject* field is the email Subject header, the in-app notification
  title, and the ntfy push title respectively — edit it per channel. ntfy
  bodies are plaintext (the push is not rendered as markdown); the tap
  link, priority and severity icon are added automatically and are not
  part of the template.
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
