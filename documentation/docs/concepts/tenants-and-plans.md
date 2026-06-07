---
verified: 2026.6.7
---

# Tenants and plans

A **tenant** is one customer account. A **plan** is the template of limits and
features a tenant inherits. Everything a customer does — websites, mailboxes,
databases, files — happens inside their tenant, isolated from every other
tenant on the platform.

## What isolation means

Each tenant lives in its own Kubernetes namespace (`client-{id}`) with:

- a dedicated pod running their chosen runtime,
- their own storage volume,
- network rules that block traffic to and from other tenants,
- resource limits (CPU, memory, storage) drawn from their plan.

You don't manage any of that directly — you create a tenant, pick a plan, and
the platform provisions the namespace, quota, network policy, and storage.

## The tenant lifecycle

A tenant moves through a small set of states. In the admin panel you change
state from the **status dropdown** on the tenant; the platform runs the right
work behind the scenes and shows live progress.

| State | Meaning | What happens |
|---|---|---|
| **active** | Normal, running | Workloads serve traffic; mail flows. |
| **suspended** | Temporarily off | Workloads scale to zero, mail access is blocked, ingress is gated — **data is kept**. Reversible: resuming restores the prior replica counts. |
| **archived** | Cold, retained | A final snapshot is taken, then workloads, storage volume, and mailboxes are deleted. The snapshot is retained (default 90 days). |
| **deleted** | Gone | Namespace, snapshots, and database rows are dropped. Irreversible. |

Restoring an archived tenant back to **active** recreates its storage and
restores data from the pre-archive snapshot.

!!! warning "Suspend keeps data, archive deletes it"
    **Suspend** is the reversible "pause" — nothing is destroyed. **Archive**
    is destructive: it removes the running tenant but keeps a snapshot you can
    restore from for the retention window. Workloads must be redeployed and
    mailboxes are **not** automatically recreated after restoring from archive.

## Plans, quotas, and overrides

A plan defines a complete set of defaults. The platform ships three starting
templates — **Starter**, **Business**, **Premium** — but they are fully
editable, and you can create unlimited custom plans.

| Setting (examples) | Starter | Business | Premium |
|---|---|---|---|
| CPU request / limit | 50m / 500m | 100m / 1000m | 200m / 2000m |
| Memory request / limit | 64Mi / 256Mi | 256Mi / 1Gi | 512Mi / 4Gi |
| Storage | 5Gi | 20Gi | 50Gi |
| Database | Add-on | Add-on | Included (dedicated) |
| Max domains | 1 | 5 | Unlimited |
| Email accounts | 5 | 25 | Unlimited |
| WAF | Available (off by default) | Available (off by default) | Enabled |

A tenant stores its `plan_id` plus an optional set of **overrides**. The
effective configuration is *plan defaults merged with the tenant's overrides* —
so you can give one Starter customer 50Gi of storage without changing the
Starter plan, then clear the override later to revert them to the plan default.
Changing a plan's default applies to every tenant on that plan **except** where
an explicit override exists.

Manage plans under **Platform Settings → Hosting Plans** in the admin panel.

!!! note "AI-assisted *file editing*, not a website builder"
    Plans include a weekly AI budget for **AI-assisted file editing** in the
    tenant File Manager — an assistant that helps edit existing files, with a
    per-plan token budget. There is **no** no-code "AI website builder"; that
    larger idea was descoped. Treat the AI feature as an editing aid only.

## Subscriptions and billing

Insula tracks plan assignment and subscription state but is **not** a billing
engine — pricing strategy and invoicing are out of scope by design. Use the
`billing` staff role and the subscription fields for plan changes; integrate
your own billing system for charging customers.

!!! info "The SYSTEM tenant"
    One special tenant has `is_system = TRUE`. It owns the platform's apex
    domain and platform-owned mailboxes (`noreply@`, `postmaster@`, …) and is
    provisioned automatically on every install. It **cannot** be suspended,
    archived, or deleted — guards at every layer enforce this. Use it to host
    platform-owned websites and transactional mail through the normal flows.
    (ADR-040)

??? info "Under the hood"
    - Every state transition runs through a **lifecycle hook registry**: a
      topo-sorted set of hooks dispatched per transition, each run persisted and
      retried with exponential backoff on failure (ADR-033). Operators see
      per-hook success rates under **Platform Settings → Tenant Lifecycle
      Hooks**.
    - Suspend/resume run inline as part of the status change; archive/restore
      run asynchronously in a storage orchestrator and report live progress.
    - Authoritative sources:
      [TENANT_LIFECYCLE.md](https://github.com/insulahq/insula/blob/main/docs/architecture/TENANT_LIFECYCLE.md),
      [HOSTING_PLANS.md](https://github.com/insulahq/insula/blob/main/docs/architecture/HOSTING_PLANS.md),
      [ADR-040](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-040-system-tenant.md),
      [ADR-033](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-033-tenant-lifecycle-hook-registry.md).
