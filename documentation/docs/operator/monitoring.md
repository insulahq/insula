---
verified: 2026.6.7
---

# Monitoring & health

Insula's monitoring is deliberately built-in and lightweight. There is no
metrics jungle to operate — the platform watches the things that matter and tells
you, through the panel and notifications, when one of them goes wrong.

!!! warning "There is no bundled Prometheus / Grafana / Loki"
    Insula does **not** ship a Prometheus/Grafana/Loki/Alertmanager stack. The
    observability you get out of the box is the **Monitoring** page, the
    **node-health** and **cluster-health** checks, **backup health**, and the
    **notifications** system. If you want full metrics dashboards or central log
    aggregation, run your own external stack and point it at the cluster — Insula
    doesn't block it, it just doesn't bundle it.

## The Monitoring page

**Monitoring** has these tabs:

| Tab | What it shows |
|---|---|
| **Active Alerts** | Current platform alerts |
| **Alert History** | Past alerts |
| **Health** | Real platform-health checks (not placeholders) |
| **Node Health** | Per-node severity, readiness, pressures, CSI drivers, evictions/h, disk % |
| **Storage Usage** | Storage consumption |
| **Pods** | Pod-level view |

The top summary cards (Platform Status, Active Alerts, Pod Usage) are quick
read-outs; the **Health** tab carries the real checks.

## Node health and recovery actions

The **Node Health** tab is the one to watch. A 5-minute reconciler tracks, per
node:

- **Pressure** — DiskPressure / MemoryPressure / PIDPressure → critical.
- **CSI drivers** — a node missing a baseline storage driver → critical (this is
  what silently broke tenant volumes in a past incident).
- **Evictions in the last hour** — ≥3/h warning, ≥10/h critical.
- **Not Ready** → critical.

When a node is in trouble, you get **recovery actions** without leaving the
panel:

- **Clean stale pod records on this node** — bulk-deletes Failed/Evicted pods
  (refuses tenant + database pods; zero risk).
- **Restart Longhorn CSI plugin on this node** — re-registers the storage driver
  when a baseline driver is missing.
- **Recycle a specific system pod** — deletes a pod with runaway storage so its
  controller reschedules it and the writable layer is reclaimed.

The same severity badge appears on the node's card under **Cluster → Nodes**
(see [Nodes & cluster](nodes-and-cluster.md)). Use **Reconcile now** to force a
fresh check instead of waiting out the 5-minute tick.

## Cluster health

The **Cluster → Nodes** page carries a compact cluster health bar: how many
nodes are Ready, CPU/memory pressure counts, cordoned/drained counts, and worker
subsystem (Calico / Longhorn CSI) issues. When everything is fine it collapses to
a single green "All systems healthy" chip; problems surface as red/amber chips.

## Backup health

Backup health is surfaced as a banner and table — last successful backup per
class/tenant, so a silently-failing backup doesn't hide. Pair this with the
checks in [System backups & DR](system-backups-dr.md) and
[Tenant backups](tenant-backups.md).

## Notifications

The notifications system is how the platform reaches *you* when something needs
attention. The model is **Sources × Providers**, managed on
**Platform Settings → Notifications**:

| Tab | What it configures |
|---|---|
| **Sources** | What triggers a notification — per-event (security, subscription, tenant lifecycle, backups, node health…), with default channels and rate limits |
| **Providers** | The transports that deliver them (SMTP relays today — your own Stalwart, Postmark, Brevo, …) |
| **Templates** | Operator-editable Handlebars templates per source/channel/locale |
| **Delivery Log** | Per-channel delivery outcomes, for audit and triage |

Node-health transitions, backup failures, security-hardening drift, and tenant
lifecycle events all flow through here. Each source can be enabled, disabled, and
routed independently. Email is sent asynchronously, so a slow relay never blocks
the platform.

!!! tip "Wire up a Provider on day one"
    Configure at least one SMTP Provider and confirm a test notification arrives.
    Monitoring you never see is monitoring you don't have.

## External monitoring

Because Insula runs on k3s, an external monitoring stack can scrape and observe
it like any Kubernetes cluster — node and pod metrics, ingress, etc. That's an
operator choice and out of scope for the built-ins above. The target design (and
the open decision about adopting it) is documented in
[Monitoring & Observability](https://github.com/insulahq/insula/blob/main/docs/operations/MONITORING_OBSERVABILITY.md).

??? info "Under the hood"
    Node-health lives in `backend/src/modules/node-health/` and notifies admins
    on severity transitions (with a 24-hour re-notify on sustained
    warning/critical and a recovery notice). Bootstrap also writes host-side disk
    caps (no core dumps, journald capped at 2 GB, calico log rotation) so a stuck
    pod can't fill a node's disk — the failure mode behind the original
    node-health work. Details:
    [Node Health Monitoring](https://github.com/insulahq/insula/blob/main/docs/operations/NODE_HEALTH_MONITORING.md),
    [Notifications](https://github.com/insulahq/insula/blob/main/docs/features/NOTIFICATIONS.md).
