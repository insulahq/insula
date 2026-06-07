---
verified: 2026.6.7
---

# Email

Insula runs a full mail server (Stalwart — SMTP, IMAP, JMAP) for your
tenants. As the admin you manage per-tenant email domains and mailboxes,
keep deliverability healthy, choose the webmail experience, and handle
mail-server placement and recovery. The **Email** sidebar group is split
into four pages, and a live **mail health banner** rides at the top of all
of them so you never lose sight of whether mail is actually flowing.

The health banner runs real probes — Stalwart pod readiness, a JMAP HTTP
check, TLS certificate, ports, and deliverability (rDNS / PTR, DNSBL
listing, banner, certificate SAN). Click it for the full per-component
details modal, or refresh to bypass the cache and probe again.

## Domains & Relays

**Email → Domains & Relays** is the daily-driver page. It has two tabs.

### Domains

A table of every tenant email domain, showing the mailbox count and, for
each of **MX**, **SPF**, **DKIM**, and **DMARC**, whether the required DNS
is provisioned. This is your at-a-glance "is this domain set up to send
and receive mail correctly?" view.

The **DKIM** button opens a read-only status modal for the domain. It
lists the active DKIM **selectors** Stalwart is publishing.

!!! note "DKIM rotation is Stalwart-native"
    Stalwart generates and rotates DKIM keys itself — the panel shows you
    the current selectors but does not rotate them from here. To rotate
    manually, use the Stalwart admin UI (see *Settings* below). The DKIM
    DNS records you publish should match the selectors shown in this modal.

### SMTP Relays

The cluster's **outbound** mail path. By default Stalwart delivers
directly (which needs good IP reputation and a correct PTR record). If you
relay through an external smarthost instead, register it here with **Add
SMTP Relay**, and use the per-relay **Test** action to confirm it works.

## Settings

**Email → Settings** holds the platform-side mail configuration, in three
sub-tabs, plus an embedded Stalwart admin panel.

- **Server** — the **SMTP/IMAP hostname** Stalwart advertises (it drives
  connection banners and the outbound EHLO, and must be a valid FQDN). The
  page warns you that changing it has knock-on effects: the new hostname
  must be on the certificate SAN, in DNS MX records, and have correct
  forward-confirmed reverse DNS (FCrDNS) at your IP provider before
  outbound mail will be trusted.
- **Webmail** — the **webmail engine** and URL (below).
- **Backup Engine** — which engine captures per-tenant mailbox data for
  the [tenant restore cart](backups-and-restore.md).

The collapsible **Stalwart admin UI** card embeds the upstream Stalwart
web admin for everything the panel doesn't surface natively — advanced
filters, log inspection, manual DKIM rotation.

### Choosing the webmail engine

Two webmail engines ship, and the selector is **platform-wide** — every
mailbox lands in whichever one you pick when the customer clicks "Open
Webmail". Both share the same `webmail.<apex>` URL; flipping the engine
just changes which backend serves it.

| Engine | Notes |
|--------|-------|
| **Roundcube** | The classic, widely-known webmail. |
| **Bulwark** | A modern JMAP-native client; supports master-user impersonation so a tenant admin can open any of their mailboxes SSO-style. |

Switching engines triggers a rollout (tracked in the Task Center).

### Webmail feature toggles (Contacts / Calendar / Files)

Below the engine selector are three independent toggles — **Contacts**,
**Calendar**, and **Files** — all **off** by default. Turning one on shows
that feature in the webmail UI.

!!! info "The toggles are cosmetic only"
    These switches change webmail's CSS to show or hide the feature tabs.
    They do **not** disable the underlying CalDAV/CardDAV endpoints —
    native clients (Thunderbird, iOS Mail, macOS Contacts/Calendar)
    keep working over DAV regardless of the toggle. Use the toggles to
    simplify the webmail UI, not as a security control.

## Operations

**Email → Operations** is for day-99 actions, in three sub-tabs.

- **Placement & migration** — the mail-server placement and **disaster
  recovery** card: failover, failback, migrate to another node, and
  standby data-freshness. Port exposure is tucked behind an "Advanced
  (debugging only)" collapsible — the default (`allServerNodes`) is
  correct for almost everyone.
- **Backups** — the **mail archive** (Stalwart-native `stalwart -e` LZ4
  export — a whole-server point-in-time export, good for DR drills and
  cold backups). The tab also reminds you of the *three distinct
  mail-backup paths* and where each lives:

    | Path | What it is | Where |
    |------|------------|-------|
    | **Archive** | Stalwart-native whole-server export | this tab |
    | **Snapshots** | restic backup of the mail volume | [Backups → System](backups-and-restore.md) |
    | **Per-tenant bundles** | mailbox-only capture | the engine in *Settings → Backup Engine*; used by the restore cart |

- **Storage** — the per-volume storage view for the mail data.

## Data Drift

**Email → Data Drift** surfaces mismatches between the platform database
and Stalwart's own datastore — typically the residue of a failed mail-stack
operation, where the platform DB has a domain or mailbox that Stalwart is
missing (or vice versa). The page explains each drift item and offers
remediation (dismiss, or recreate the missing Stalwart entry empty).

!!! warning "Recreating empty loses messages"
    "Recreate empty" rebuilds the missing Stalwart entry with no data — a
    mailbox comes back empty, and a domain comes back without its original
    DKIM keys. To preserve messages and DKIM, restore Stalwart from a
    snapshot instead (the page links the procedure). Treat this page as a
    surface for *pre-existing* drift, not a routine tool.

## Per-tenant email

To manage one tenant's mailboxes, open that tenant and use its **Email**
tab (see [Tenants](tenants.md)). The cross-tenant **Tenants → Email
Accounts** tab gives you every mailbox in one searchable list.
