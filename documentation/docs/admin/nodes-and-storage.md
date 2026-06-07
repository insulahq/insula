---
verified: 2026.6.7
---

# Nodes & storage

The **Cluster** sidebar group is where the admin panel meets the physical
servers. Most of it is operator territory (joining nodes, networking,
firewalls — see the [Operator guide](../operator/nodes-and-cluster.md)),
but two pages — **Nodes** and **Storage** — are where you watch capacity,
place tenants, and reach the Longhorn dashboard day to day. This chapter
covers those from the admin's seat.

## Cluster → Nodes

**Cluster → Nodes** lists every node in the k3s cluster as a card, with a
health summary across the top (Ready / cordoned / drained counts, plus any
subsystem problems). Each node card shows:

- The node **name** and an editable **alias**.
- Its **role** — *server* (control-plane + ingress) or *worker*.
- Whether it **hosts tenant workloads**.
- Its **ingress mode**.
- Live CPU / memory / disk saturation and last-seen freshness.
- Subsystem health (Calico, Longhorn CSI).

!!! note "The k8s labels are the source of truth"
    Edits you make here write the corresponding label on the Kubernetes
    node first, then refresh. The platform reconciler ticks every ~60s, so
    a freshly joined node may take a moment to appear.

### Editing a node

The **Edit** button on a node card opens a modal where you set:

- **Role** — *server* or *worker*. Demoting a server to worker is a
  destructive change and is gated accordingly.
- **Host tenant workloads** — whether tenants can be scheduled here.
- **Ingress mode** — three states:
    - **All** — nginx runs here, advertises this node's public IP, and can
      forward to any pod cluster-wide (the default for system servers).
    - **Local** — serves only pods on this node.
    - **None** — no nginx here; workloads still run, but public traffic is
      served by the system servers.

### Draining and removing a node

Each card has drain/delete actions (via the drain-delete modal). Deleting a
node removes it from the cluster (kubectl delete + DB row) **without**
touching the host itself — the machine keeps running.

!!! warning "The last node is protected"
    The platform refuses to drain the only schedulable, tenant-capable
    node — draining it would strand every tenant. You'll get a blocked
    error rather than an outage.

### The node terminal

Every **Ready** node card carries a **Terminal** button (super_admin
only). It opens a privileged shell on that node's host, inside a modal that
survives navigation — start a session on one node, move elsewhere in the
panel, and the dock keeps it restorable. Sessions self-destruct on close,
after 15 minutes idle, or after one hour.

This is a powerful, audited break-glass tool. Its security model
(step-up freshness gate, single-use tokens, the `node-terminal-enabled`
feature flag, and how it's gated off in production by default) is covered
in the [Operator guide](../operator/nodes-and-cluster.md) — read that
before relying on it.

## Cluster → Storage

**Cluster → Storage** is the storage control surface.

- **Storage inventory** — live node health, volume count, and capacity.
- **Longhorn dashboard** — Longhorn provides the cluster's persistent
  volumes (volume health, snapshots, backups, node capacity). Click **Open
  Longhorn** to view it inside the panel (an iframe modal), or **Open in
  new tab**. If the Longhorn URL isn't set, the page points you at
  [Platform → Integrations](platform-settings.md) to configure it. Access
  is gated — only admins reach it.
- **Active backup target** — a summary of which Remote Storage Target
  Longhorn backs up to, or a "none configured" prompt if Longhorn volumes
  aren't being backed up yet.
- **Orphaned volumes** — a maintenance surface for storage drift:
  persistent volumes / Longhorn volumes whose owning tenant is gone, or
  that linger in a Released phase past the stale threshold. The **Manage**
  button lets you review and reclaim them.

!!! info "Snapshots, backups, and reclaim"
    Storage-lifecycle housekeeping (snapshot scheduling, orphan reclaim)
    runs automatically on a scheduler. The Storage page exposes the manual
    levers for when you want to act now rather than wait for the next tick.

## Quotas and per-tenant storage

A tenant's storage limit comes from its **plan** and can be **overridden**
per tenant on the tenant detail page's *Resource Limits* card — including
online grow and (guarded) destructive shrink. That's the right place to
change one customer's storage; see [Tenants](tenants.md). The Storage page
here is about *cluster-wide* capacity and health, not per-tenant limits.

## Tenant placement

When you create a tenant you can pin it to a specific node, and its
**storage tier** (local vs HA) is chosen there too. The node dropdown
shows live free capacity per node so you can place heavy tenants on roomy
hardware. Existing placement shows in the tenant's *Placement* card. See
[Tenants](tenants.md).

## What lives elsewhere in Cluster

The other Cluster pages are operator-facing: **Cluster Policies** (HA mode
toggle, node image-GC defaults), **Networking**, **Ingress & TLS**, **Load
Balancer**, and **Private Worker Tunnels**. They're documented in the
[Operator guide](../operator/nodes-and-cluster.md).
