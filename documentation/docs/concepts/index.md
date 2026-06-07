---
verified: 2026.6.7
---

# The Insula mental model

Insula turns a few Linux servers into a complete hosting business — websites,
databases, email, backups, and two control panels. Underneath it runs
[k3s](https://k3s.io) (lightweight Kubernetes), but you never have to think in
Kubernetes terms. Everything is expressed in hosting language: tenants, plans,
domains, mailboxes.

Five ideas explain almost everything you'll see in the panels. Learn these and
the rest of the manual reads as detail.

## 1. A cluster of nodes runs everything

A **node** is one Linux server you own. One node is enough to start; you add
more later for capacity or high availability. Together the nodes form a
**cluster**.

Insula installs and operates k3s on every node for you — it joins nodes,
upgrades them, watches their health, and schedules work across them. Two kinds
of node exist:

| Node role | Runs |
|---|---|
| **Server** | The control plane (cluster brain) plus platform services — the API, panels, database, mail. |
| **Worker** | Tenant websites and apps only. Workers exist to add capacity for customers. |

A single-node install is a server that also hosts tenant workloads. See
[Grow to multiple nodes](../getting-started/multi-node.md).

## 2. Tenants are isolated customers

A **tenant** (also called a client) is one customer account. Every tenant is
**isolated** from every other: its own Kubernetes namespace, its own storage,
network rules that block cross-tenant traffic, and resource limits drawn from
its plan.

A **plan** is a template of limits and features — CPU, memory, storage, how
many domains and mailboxes, whether a database add-on is included. You can
override any setting for an individual tenant without changing their plan.

Read more in [Tenants and plans](tenants-and-plans.md).

## 3. One catalog of deployable software

Tenants deploy software from a single **catalog** (the **Applications** page in
the panels). One catalog covers the whole range — there is no separate
"workloads" vs "applications" split:

| Entry type | What it is | Examples |
|---|---|---|
| **Runtimes** | A blank environment you upload your own code into | PHP, Node.js, Python, Go, … |
| **Databases / services** | Data stores a site can use | MariaDB, PostgreSQL, Redis, … |
| **Applications** | Complete, self-contained products deployed as one unit | WordPress, Nextcloud, Jitsi |

A default **Official Catalog** is enabled out of the box, so tenants can deploy
immediately. You can remove it, and you can add your own catalog repositories.
Tenants who need a one-off image can also bring their own container or
`docker-compose` file.

Read more in [The catalog](catalog.md).

## 4. Domains flow into routes, then TLS

When a tenant adds a domain, the path to a live, encrypted site is:

```
domain added → verified → routes map hostnames to a workload
            → Traefik ingress serves the request
            → cert-manager issues a free Let's Encrypt certificate
```

DNS can be platform-managed, CNAME-based, or secondary — the tenant picks a mode
per domain. Email subdomains like `webmail.<domain>` are provisioned
automatically. Read more in [Domains, routing and TLS](domains-routing-tls.md).

## 5. Backups live off-cluster

Backups never count as "safe" if they sit on the same cluster they protect.
Insula writes backups to **external targets you configure** — S3-compatible
object storage, an SFTP server, or an SMB/CIFS share. There are three distinct
layers (tenant bundles, platform snapshots, and a whole-platform DR bundle),
each answering a different "what if". Read more in
[Storage and backups](storage-and-backups.md).

## Where things run

```text
   Visitors / customers
            │  (HTTPS)
            ▼
┌──────────────────────────────────────────────────────────────┐
│  Insula cluster (k3s)                                          │
│                                                                │
│  ┌─ Server node(s) ──────────────┐  ┌─ Worker node(s) ──────┐ │
│  │  control plane + platform      │  │  tenant capacity      │ │
│  │                                │  │                       │ │
│  │  Traefik ingress + WAF ───────────►  client-acme ns       │ │
│  │  Platform API ────────────────────►    site + storage     │ │
│  │  Admin & tenant panels         │  │  client-globex ns     │ │
│  │  PostgreSQL (CNPG)             │  │    site + DB add-on   │ │
│  │  Stalwart mail server          │  │  client-… ns          │ │
│  └────────────────┬───────────────┘  └───────────┬───────────┘ │
└───────────────────┼──────────────────────────────┼────────────┘
                    │  backup                       │  backup
                    ▼                               ▼
        External backup target (S3 / SFTP / SMB) — off-cluster
```

!!! note "Single node?"
    On a one-node install everything above lives on the same server — the
    server node also hosts tenant namespaces. The layout is identical; only the
    machine count differs.

??? info "Under the hood"
    - **k3s** is a CNCF-conformant Kubernetes distribution with a smaller
      footprint — ideal for VPS and bare metal. Insula uses **Calico** for the
      container network (so per-tenant network policies are enforceable) and
      **Traefik v3** for ingress (ADR-038).
    - Each tenant gets a dedicated pod in a `client-{id}` Kubernetes namespace
      with a `ResourceQuota`, a `NetworkPolicy` (default-deny + allow ingress),
      and its own `PersistentVolumeClaim` (ADR-024).
    - The platform database is **PostgreSQL** managed by CloudNativePG (CNPG).
      The platform's own cache is in-memory; there is no Redis dependency.
    - The full technical architecture lives with the source:
      [PLATFORM_ARCHITECTURE.md](https://github.com/insulahq/insula/blob/main/docs/architecture/PLATFORM_ARCHITECTURE.md)
      and the [ADR index](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ARCHITECTURE_DECISION_RECORDS.md).
