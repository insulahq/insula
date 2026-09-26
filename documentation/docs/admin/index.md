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
| **Dashboard** | The Operator Console — capacity, mail, web defence, and anything needing attention (below). |
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

## The Operator Console

The Dashboard is deliberately *not* a wall of counters. It answers two
questions — **"does anything need me right now?"** and **"has the cluster
got room?"** — and links you to the fix. Every tile is clickable and takes
you to the page that acts on it, and hovering a tile opens a card with the
detail behind the number.

A small **Refresh** sits at the top right, in line with the page title. Both
of the requests feeding the page are re-read together — refreshing one would
leave the capacity tiles stale beside fresh warnings — and it greys out while
a fetch is in flight.

### Needs attention

The first section **only appears when something is wrong**. When the
platform is healthy it is absent entirely — not an empty box, not a row of
green ticks. A row of warnings that is usually blank is a row people learn
to skip past, and this is the one row that must never be skipped.

What can raise it: a tenant whose workloads are not running, a tenant over its
storage, a mailbox that is nearly full (which is what actually starts refusing
mail), a volume nearly full (which is what stops a workload writing), orphaned
pods left on a node, failed lifecycle transitions, backups that are failing or
have never run, and certificates close to expiry. Each entry links to the
tenant, volume or page that resolves it.

Three details worth knowing:

- **"Volume nearly full" is measured inside the volume** — the used and free
  space its filesystem reports, which is what decides whether the workload can
  still write. It is not the space the volume occupies on the host; a volume
  with hourly snapshots can hold several times its own contents there without
  being anywhere near full. Inode exhaustion counts too: a volume out of
  inodes refuses writes while it still looks half empty.
- **"Orphaned volume" opens the management list in place** rather than sending
  you to the Storage page to find the button. Each volume is listed with its
  size, how long its claim has been gone, and snapshot and delete beside it.
- **"Tenant workload down" means the platform already tried.** A tenant's
  application can be completely unreachable while every component around it
  reports healthy — the namespace exists, the volume is attached, the node is
  Ready, nothing has been OOM-killed. So the platform watches the only thing
  that actually answers the question: whether each workload has the replicas its
  own spec asks for. A workload short of them for more than eight minutes opens
  an episode, and the platform attempts recovery itself before telling you (see
  [Workloads that stop running](../operator/monitoring.md#workloads-that-stop-running)).

    The card only appears once the outage has outlived that grace window, so a
    rolling update or a cold image pull never raises it. The hover card says how
    long each workload has been down, the cause, and whether automatic recovery
    has been tried, is running, or has failed — which is the difference between
    "wait" and "this needs you". The closing line says which it is.

### Cluster capacity

Capacity is shown as **three** figures per resource, not one:

| Figure | Meaning |
|---|---|
| **In use** | What is actually being consumed right now. |
| **Committed** | What workloads have *reserved*, whether or not they are using it. |
| **Available** | What is left to schedule. |

These differ enormously, and the difference is the thing that bites: a
cluster can sit at 12% actual usage and still refuse to start anything,
because the room is already reserved. A single "usage" percentage hides
that completely.

Storage is the exception — it is consumed rather than reserved, so it
reads as used against total.

**In use** can read as *usage unavailable*, and that means exactly one thing:
the metrics service did not answer. A measured **zero** is shown as zero — an
idle workload really does use none, and calling that "unavailable" would hide
the difference between a quiet cluster and a blind one. A node with no sample
shows an em-dash in its row, and a cluster figure missing any node reads as
unknown rather than as the sum of the nodes that did answer, which would
understate usage in the direction that looks healthy.

Underneath, a **Failover** line says in plain words whether the cluster
would survive losing its busiest node.

### Nodes

Section headings are names only — no counts or legends beside them, and no
rules running off to the page edge. The number is in the section itself.

One row per node with the same in-use / committed / available breakdown, so
you can see which node is carrying the cluster. Hovering a row opens its
full detail — kubelet version, age, pod count and conditions. Long node
names are truncated rather than pushing the layout sideways.

### The rest of the console

| Tile | What it tells you |
|---|---|
| **Tenants & workloads** | Tenant count by state, and how many workloads are running, pending or failing. |
| **Mail — last 7 days** | Delivery volume, rejections and the fullest mailbox on the platform. |
| **Web defence — last 24 hours** | Requests blocked, the rules that fired, and the noisiest sources. |
| **Backups & DR** | The three backup classes — system, tenant and mail — each with its target, last run and age. |
| **Certificates** | What is issued, what renews soon, and anything that failed to renew. |
| **Cron & platform jobs** | Scheduled work, and anything that has not run when it should have. |
| **Platform** | Running version, available upgrades, and recent changes. |

!!! tip "If something is flagged, click it"
    Every signal deep-links to the page that fixes it. You should rarely
    need to hunt through the sidebar during an incident — start here and
    follow the links.

!!! note "How it loads"
    The page fetches from two requests rather than one per tile, and each
    refreshes on a schedule matched to how fast that data actually changes.
    Refreshing stops while the tab is in the background. Each tile reports
    its own state, so one slow source greys a single tile and says why
    instead of leaving the page blank.

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
