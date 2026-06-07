---
verified: 2026.6.7
---

# Getting started

This section takes you from a bare Linux server to a live customer website with
TLS. If you've read [The Insula mental model](../concepts/index.md), everything
here will click; if not, skim it first.

## The three hats

Insula assumes three kinds of people. Most small setups start with one person
wearing all three — the separation just keeps access and tooling clean.

| Hat | Owns | Works in | Start at |
|---|---|---|---|
| **Operator** | The servers | The terminal (`bootstrap.sh`) + admin panel | [Requirements](requirements.md) → [Install](install.md) |
| **Admin** | The hosting business | The **admin panel** | [Your first tenant](first-tenant.md) |
| **Tenant** | One customer account | The **tenant panel** | the tenant guide |

## What the path looks like

```text
 1. Check          2. Run            3. First login    4. Add a catalog   5. Create a tenant
    requirements  ─►  bootstrap.sh ─►   to the admin  ─►   repo + a plan ─►   + domain + site
    (server,          (one command)     panel                                    │
     OS, DNS)                                                                     ▼
                                                                      Live site with auto TLS
```

The first install is roughly a 15-minute path on a fresh server:

1. **Confirm prerequisites** — one supported Linux server, a domain you
   control, and DNS access. See [Requirements](requirements.md).
2. **Run `bootstrap.sh`** — one command installs k3s, the firewall, the full
   platform, and prints your first admin login. See
   [Install a single node](install.md).
3. **Log in** to the admin panel and verify the install.
4. **Create a plan** — the catalog is already enabled by default.
5. **Create your first tenant**, add a domain, and deploy a site from the
   catalog. See [Your first tenant](first-tenant.md).

Later, when you need more capacity or zero-downtime resilience, you
[grow to multiple nodes](multi-node.md) and flip on high availability with a
single action.

## What you need before starting

- A server you have **root/SSH** access to, running a supported OS.
- A **domain name you control**, with the ability to edit its DNS.
- An email address for Let's Encrypt certificate registration.
- A few command-line basics — you'll run one script and copy a couple of
  values.

You do **not** need to know Kubernetes. Insula installs and operates it for you.

!!! tip "Just want to look around first?"
    You can install on a small throwaway VPS to explore the panels before
    committing real customers. 4 GB RAM is enough to try it;
    [Requirements](requirements.md) has the sizing detail.
