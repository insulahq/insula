# Insula

**Your servers. Your platform. Their websites.**

Insula is an open-source web-hosting platform that turns a handful of Linux
servers into a complete, modern hosting business — websites, databases, email,
backups, and two polished control panels — without you having to operate
Kubernetes by hand or pay per-server panel licenses.

If you have run Plesk, cPanel, or Virtualmin before: Insula plays the same
role, rebuilt on today's infrastructure. One command installs the whole stack
on a fresh server; everything after that happens in a browser.

<div class="grid cards" markdown>

- :material-rocket-launch: **[Get started](getting-started/index.md)**

    Install Insula on a single server in about 15 minutes, then create your
    first tenant and website.

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

## What you get

| | |
|---|---|
| **Websites & apps** | PHP, Node.js, Python, static sites and more from a curated catalog — or bring your own container. Each customer runs isolated from every other. |
| **Email** | A full mail server (SMTP/IMAP/JMAP) with per-domain DKIM, webmail, aliases, autodiscover, and deliverability checks built in. |
| **Databases** | Per-tenant MariaDB/PostgreSQL with a browser-based manager — tables, SQL console, import/export. |
| **Backups** | Scheduled tenant backups with a shopping-cart-style granular restore, plus whole-platform disaster recovery to S3/SFTP/SMB targets. |
| **Security** | Per-site WAF (OWASP rules), automatic intrusion bans, free TLS certificates, role-based access, passkeys. |
| **Growth path** | Start on one ~€10/month VPS; add nodes and switch on high availability later with a single action — no migration day. |

## How it's built (the short version)

Under the hood every Insula node runs [k3s](https://k3s.io) — a lightweight
Kubernetes — but **Kubernetes is an implementation detail, not your job**. The
platform installs it, upgrades it, watches it, and translates everything into
hosting language: tenants, plans, domains, mailboxes. You only reach for
`kubectl` if you want to.

When you do want the deep technical picture — architecture decisions, data
model, network design — it lives with the source code in the
[`docs/` directory](https://github.com/insulahq/insula/tree/main/docs) of the
repository. This manual deliberately stays at the level of *running and using*
the platform.

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

---

*Insula is licensed under AGPL-3.0. Source, issues, and contributions:
[github.com/insulahq/insula](https://github.com/insulahq/insula).*
