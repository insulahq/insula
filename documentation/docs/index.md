# Insula

**Your servers. Your platform. Their websites.**

Insula is an **open-source hosting platform** that turns a handful of Linux
servers into a complete hosting business — websites, databases, a full mail
server, backups, and two polished control panels — for **zero license fees,
forever**. One command installs the whole stack on a fresh VPS; everything
after that happens in a browser.

If you run Plesk, cPanel, or Virtualmin today: Insula plays the same role,
rebuilt on the infrastructure the rest of the industry moved to years ago —
and it will import your Plesk subscriptions, sites, databases, mailboxes, and
cron jobs for you.

<div class="grid cards" markdown>

- :material-rocket-launch: **[Get started](getting-started/index.md)**

    Install Insula on a single ~€10/month server in about 15 minutes, then
    create your first tenant and website.

- :material-lightbulb-on: **[Understand the concepts](concepts/index.md)**

    The five ideas — tenants, workloads, domains, mail, backups — that make
    everything else in the panels obvious.

- :material-server: **[Operator guide](operator/index.md)**

    Run the platform itself: nodes, high availability, updates, disaster
    recovery, hardening.

- :material-account-tie: **[Admin guide](admin/index.md)** · :material-account: **[Tenant guide](tenant/index.md)**

    Day-to-day work in the admin panel, and the manual you can hand to your
    customers.

</div>

## Why Insula over the alternatives

**Against the legacy panels (Plesk, cPanel, DirectAdmin):**

- **No per-server, per-account license treadmill.** Insula is AGPL-licensed
  open source. Your costs are your servers — that's it.
- **Real isolation, not shared-everything.** Legacy panels put every customer
  on one shared web server and one shared filesystem, where one compromised
  site can reach the next. Every Insula tenant runs in its own kernel-enforced
  sandbox with its own network rules, resource quotas, and storage — a noisy
  or hacked site stays *that* site's problem.
- **Modern runtimes as first-class citizens.** PHP next to Node.js, Python,
  Go, Java, .NET, or any container image — not a PHP panel with extras bolted
  on. Switch a site's runtime version without moving files.
- **A migration path, not a leap.** The built-in importer connects to your
  existing Plesk server over SSH and moves subscriptions — sites, databases,
  mailboxes (unread flags included), DNS, cron jobs — tenant by tenant, on
  your schedule.

**Against DIY Kubernetes or single-user PaaS tools:**

- **Multi-tenant by design.** Plans, quotas, per-tenant panels, sub-users,
  suspension/archival lifecycles — the machinery of *selling* hosting, which
  deploy-tools built for one team simply don't have.
- **Mail is included and taken seriously.** A full SMTP/IMAP/JMAP server with
  per-domain DKIM, webmail, autodiscover, deliverability probes (PTR, DNSBL),
  send-rate protection, and abuse alerts. This is the feature every "modern
  Plesk alternative" skips because it's hard.
- **Kubernetes without the Kubernetes job.** Every node runs
  [k3s](https://k3s.io) under the hood, but Insula installs it, upgrades it,
  watches it, and translates it into hosting language. `kubectl` is there
  when you want it and never required.

**Engineering you can check, not marketing:**

- **Failure is rehearsed.** Point-in-time database recovery, off-site
  encrypted backups (S3/SFTP/SMB), a granular restore cart, cold-start
  disaster recovery, and cluster-to-cluster tenant migration — all exercised
  by a destructive integration suite against a live cluster before every
  release.
- **Under pressure, customers' pods yield before the platform does.** Nodes
  run swap-less with reserved headroom, tenant workloads are evicted first by
  construction, and every OOM or eviction lands in the panel and in your
  inbox.
- **A supply chain you can verify.** Signed CalVer releases, verified on your
  nodes before anything upgrades; production only moves when you say so.
- **No lock-in anywhere.** Standard substrates (Kubernetes, PostgreSQL,
  Longhorn, restic), pluggable DNS providers, bring-your-own S3 — and AGPL
  source you can read, fork, and audit.

## What you get

| | |
|---|---|
| **Websites & apps** | PHP, Node.js, Python, static sites and more from a curated first-party catalog, an opt-in community app-stack catalog (WordPress, Nextcloud, …), or bring your own container. Each customer isolated from every other. |
| **Email** | A full mail server (SMTP/IMAP/JMAP) with per-domain DKIM, modern webmail, aliases, autodiscover, deliverability checks, and abuse/blocklist alerting built in. |
| **Databases** | Per-tenant MariaDB/PostgreSQL with a browser-based manager — tables, SQL console, import/export. |
| **Files & transfer** | A web file manager plus an SFTP/SCP/rsync gateway with per-purpose credentials and SSH keys. |
| **Backups** | Scheduled tenant backups with a shopping-cart-style granular restore, whole-platform disaster recovery, and tenant migration between clusters. |
| **Security** | Per-site WAF (OWASP rules), automatic intrusion bans, free TLS certificates, a managed node firewall, role-based access, passkeys. |
| **Monitoring** | Built-in metrics, SLO alerts, node health with one-click recovery actions, memory-event tracking, and per-tenant bandwidth metering with soft caps — no separate monitoring stack to run. |
| **Growth path** | Start on one ~€10/month VPS; add nodes and switch on high availability later with a single action — no migration day. |

## The three hats

Insula assumes three kinds of people, and this manual is organized the same way:

1. **The operator** owns the servers. Installs Insula, adds nodes, configures
   backup targets, applies updates. → [Operator guide](operator/index.md)
2. **The admin** runs the hosting business in the **admin panel**: creates
   plans and tenants, manages domains and mail, restores backups.
   → [Admin guide](admin/index.md)
3. **The tenant** is the customer. They get the **tenant panel**: their
   websites, mailboxes, databases, files, and backups — nothing else.
   → [Tenant guide](tenant/index.md)

One person can wear all three hats (most small setups start that way) — the
separation exists so that access, documentation, and UI each stay simple.

When you want the deep technical picture — architecture decisions, data model,
network design — it lives with the source code in the
[`docs/` directory](https://github.com/insulahq/insula/tree/main/docs) of the
repository. This manual deliberately stays at the level of *running and using*
the platform.

---

*Insula is licensed under AGPL-3.0. Source, issues, and contributions:
[github.com/insulahq/insula](https://github.com/insulahq/insula).*
