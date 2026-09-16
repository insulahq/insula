---
verified: 2026.6.7
---

# The admin panel

The admin panel is where you run the hosting business. It is a separate
web app from the tenant panel: your customers never see it. You sign in
with an admin account (see [Security](security.md) for the role model),
and from there you manage every tenant, domain, mailbox, backup, and the
platform itself.

This page is the map. Each area below has its own chapter — start here to
learn *where things live*, then drill in.

## Signing in and the top bar

!!! info "\"Waiting for the platform API…\""
    The panels are served by their own pod and come up faster than the API
    does — after a node restart, roughly two to three minutes faster. Rather
    than show a sign-in form that would reject your password, the login page
    shows **Waiting for the platform API…** with an elapsed timer, retries by
    itself, and swaps in the real sign-in form the moment the API answers.
    There is nothing to do but wait; **Retry now** just skips the backoff.
    Emergency (break-glass) sign-in is never gated this way.

After you log in you land on the **Dashboard**. The bar across the top of
every page carries, from left to right:

- A **search** box — see [Search](#search) below.
- The **Task Center** chip — long-running operations (provisioning,
  archive, restore, upgrades) register here so you can watch them even
  after you navigate away.
- A **dark-mode** toggle.
- The **notifications** bell — in-app alerts the platform raised for you.
- Your **user menu** (the person icon) — *Settings* (your own profile),
  *Change Password*, and *Sign Out*.

Just under the sidebar title you'll see a small identity block: the
**running version**, the build **branch**, and the **node** whose
`platform-api` pod is serving your request. This is the fastest way to
confirm which version is live.

## Search

The search box in the top bar finds two different kinds of thing at once,
and shows them in one drop-down list.

**Pages and tabs.** Type part of a page name and the matching destinations
appear immediately. Tabs are searchable in their own right, which is the
point — most of what you actually want is one level *below* a sidebar
entry. Typing `waf` offers *WAF Events*, *Banned IPs*, *WAF Exclusions*
and *WAF Settings* separately, and picking one lands you on that tab, not
on the page's default view. You can also search by words that aren't in
the page name: `modsecurity` finds WAF Events, `crowdsec` finds Banned
IPs, `lets encrypt` finds Ingress & TLS.

**Your records.** In the same list, below the pages, search matches live
data: tenants, domains, applications, mailboxes, scheduled tasks, admin
and tenant users, SFTP users, SSH keys, cluster nodes, catalog entries,
hosting plans and remote storage targets. Picking one takes you to it —
a mailbox opens its tenant on the Email tab, a domain opens its detail
page.

Matching is case-insensitive, so `acme` finds *Acme Ltd*.

**Keyboard.** `Ctrl+K` (`⌘K` on a Mac) jumps to the box from anywhere.
Arrow keys move through the results, `Enter` opens the highlighted one,
and `Esc` clears the box — press it twice to close the list.

!!! note "You only ever see what your role can reach"
    Search never offers a page your role cannot open, and never returns a
    record you could not already list. A `support` user searching `waf`
    gets no WAF results at all, because those pages are `super_admin`-only.

!!! tip "If the list says it couldn't search records"
    Pages keep working even when the record half fails — the drop-down
    tells you so explicitly rather than pretending nothing matched. An
    empty list means nothing matched; a warning line means the lookup
    itself failed and it is worth checking
    [Monitoring](../operator/monitoring.md).

## The sidebar — your nine areas

The left sidebar is the authoritative navigation. Some entries are single
pages; others are collapsible groups that expand to reveal sub-pages.

| Area | What lives there |
|------|------------------|
| **Dashboard** | The incident-first home page (below). |
| **Tenants** | Every customer account, plus cross-tenant tabs for Domains, Workloads, Users, Email Accounts and Cron Jobs. → [Tenants](tenants.md) |
| **Applications** | The catalog, installed deployments, upgrades, and catalog repositories. → [The catalog & applications](catalogs-and-applications.md) |
| **Backups** | Dashboard, System, Tenants, Mail, Remote Storage Targets, Disaster Recovery. → [Backups & restore](backups-and-restore.md) |
| **Email** | Domains & Relays, Settings, Operations, Data Drift. → [Email](email.md) |
| **Security** | Posture, Network Trust, Identity & Sessions, Web Defense, OIDC / SSO. → [Security](security.md) |
| **Monitoring** | Live cluster/service health, plus Audit Logs. |
| **Cluster** | Nodes, Storage, Cluster Policies, Networking, Ingress & TLS, Load Balancer, Private Worker Tunnels. → [Nodes & storage](nodes-and-storage.md) |
| **Platform Settings** | Updates, Upgrades, Identity, Hosting Plans, Limits & Regional, DNS Providers, Integrations, AI Providers, Tenant Lifecycle Hooks, Notifications, Export / Import. → [Platform settings](platform-settings.md) |

!!! note "Some pages are role-gated"
    Several pages only render for higher roles — the whole Security
    *Posture*, *Network Trust* and *Web Defense* trio plus *Upgrades* and
    *Export / Import* are `super_admin`-only, and most of Backups and
    Cluster require `super_admin` or `admin`. If a sidebar link doesn't
    work for you, your role lacks it. See [Security](security.md).

## The incident-first Dashboard

The Dashboard is deliberately *not* a vanity wall of counters. It answers
one question — **"is the platform broken right now?"** — and links you to
the fix. From top to bottom:

1. **Health banner** — a single red / amber / green line: "Platform:
   healthy / degraded / down", with an "X / Y services healthy" subline
   and a **Health details →** link into Monitoring.
2. **Four incident stat cards**:
    - **Failed / Orphaned Pods** — workloads that crashed or were left
      dangling.
    - **5xx Alerts (24h)** — server errors pulled from the audit log.
    - **Failing Backups** — backup jobs in a `failing` or never-run state.
    - **In-flight Transitions** — tenant lifecycle operations running, and
      a red count if any *failed and needs an operator*.
3. **Detail cards that only appear when something is wrong** — a backup
   health list, a failed-transitions list (each linking to the tenant and
   to the [Lifecycle Hooks](platform-settings.md) registry), and a recent
   5xx list (linking to [Audit Logs](security.md)).
4. **Recent tenants** — a small "who joined this week" table.

In the top-right of the Dashboard is a compact platform strip showing the
version, when it was last checked, and a **Deployed Images** button that
opens a modal listing every platform component's image, tag, and
ready-count. (The same modal is reachable from
[Platform Settings → Updates](platform-settings.md).)

!!! tip "If a card is red, click it"
    Every red signal on the Dashboard deep-links to the page that fixes
    it. You should rarely need to hunt through the sidebar during an
    incident — start at the Dashboard and follow the links.

## How the rest of this guide is organized

The chapters mirror the sidebar. Day-to-day customer work
([Tenants](tenants.md), [Domains & DNS](domains-and-dns.md),
[Email](email.md)) comes first; the platform-wide configuration
([Platform settings](platform-settings.md), [Security](security.md),
[Nodes & storage](nodes-and-storage.md)) comes last because you touch it
less often.

If you also operate the servers themselves (installs, node joins, OS
hardening), that work lives in the
[Operator guide](../operator/index.md) — the admin panel surfaces it but
the deep runbooks are there.
