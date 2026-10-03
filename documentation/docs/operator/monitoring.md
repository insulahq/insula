---
verified: 2026.7.2
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

**Monitoring** opens on the **Traffic** tab. It has these tabs:

| Tab | What it shows |
|---|---|
| **Traffic** | What moved over the wire — the default view; see [Traffic](#traffic) below |
| **SLOs** | Service-level indicators and the rule table |
| **Mail** | Mail-flow health |
| **Active Alerts** | Current platform alerts |
| **Alert History** | Past alerts |
| **Health** | Real platform-health checks (not placeholders) |
| **Node Health** | Per-node severity, readiness, pressures, CSI drivers, evictions/h, disk % |
| **Storage Usage** | Storage consumption |
| **Pods** | Pod-level view |

**Traffic is the landing tab.** Whether something is *wrong* already reaches
you without opening this page — alerts notify, and the summary cards at the
top of every tab carry Platform Status and Active Alerts. What traffic costs
and where it went does not announce itself, so that is what the page opens
on. SLOs and Active Alerts are one click away.
Every tab has its own address — `/monitoring/active-alerts`,
`/monitoring/slos` — so you can bookmark or share the exact view. Older links
of the form `/monitoring?tab=active-alerts` still open the right tab, and a tab
name that does not exist opens the page on its default tab instead of an error.

The top summary cards (Platform Status, Active Alerts, Pod Usage) are quick
read-outs; the **Health** tab carries the real checks.

### The SLO rules table

Below the SLI cards, the rules table lists every evaluated rule. **State** is the
first column, shown as a coloured pill — red *firing*, green *ok*, grey
*disabled* — so the leftmost column tells you what is wrong at a glance.

Every column sorts; click a header to toggle direction. The default is
**Evaluated, newest first**, so the freshest signal is on top. Two columns sort
by meaning rather than alphabetically:

- **State** orders *firing → ok → disabled*, so one click puts the worst first.
- **Evaluated** keeps rules that have never been evaluated at the bottom rather
  than treating "no timestamp" as the newest value.

### Which object is affected

Alerts are tracked **per affected object**, not per rule. The **Active Alerts**
tab has an **Affected** column, and the same identifier appears in the
notification you receive:

| Rule | Affected reads |
|---|---|
| Certificate not Ready / expiring | `certificate=<name> namespace=<namespace>` |
| Node CPU / memory, Longhorn headroom | `node=<node>` |
| Scrape target down, CNPG down | `target=<instance> job=<job>` |
| Mail certificate | `host=<hostname>` |
| SYSTEM container OOM-killed | `namespace=… pod=… container=…` |

Two broken certificates are two alerts, and each resolves on its own — fixing
one does not clear the other. Rules with no narrower subject (whole-ingress
error ratio, platform-surface latency, "is monitoring reachable") show
**platform-wide**.

### "Platform surfaces — slow requests"

This warning means **more than 5% of requests to the platform's own surfaces —
admin panel, tenant panel, webmail, Stalwart admin — took longer than 1.2
seconds, and at least ten of them did**, for fifteen minutes. The usual cause is
the management API waiting on the database, so check the API pods and the
platform database before the panels themselves.

It deliberately **excludes tenant websites**. A slow tenant application is that
tenant's problem and appears on their own health page; it is not a platform
breach, and mixing the two produced warnings no one could act on.

It also deliberately reports a *share of requests* rather than a percentile.
Percentiles need a reasonable number of requests to mean anything, and the
platform's own surfaces are quiet — a median of six requests every thirty
minutes. At that volume a "95th percentile" is just the second-slowest request,
and one slow page load would page you.

!!! note "Replaces the old 'Ingress p95 latency' warning"
    That rule measured every site the cluster serves against a 0.5 second
    target, with no minimum number of requests, and warned constantly without
    ever indicating a real problem. If you had set a custom threshold on it,
    that override was **removed rather than carried over**: the old number meant
    seconds and the new one means a percentage, so reusing it would have been
    misread. Set a new threshold if you want one.

!!! note "SOA and certificate alerts you cannot action"
    A `cert-not-ready` alert naming a domain that is still **unverified** is
    expected while DNS is being set up — the platform does not order a
    certificate until the domain verifies. See
    [Domains and DNS](../admin/domains-and-dns.md#ssltls-tab).

## Traffic

**Monitoring → Traffic** answers "what moved over the wire, for whom, and
when". Pick a time range, a breakdown, and a metric.

The **time range** control is one button showing the current range. Opening it
gives presets (last hour, 6 hours, 24 hours, 7 days, 30 days, 90 days and 12
months), two months of calendar, a time of day for each end, and the
resulting duration — so you can see what you are about to ask for before you
ask for it. A range reaching past 30 days is marked **daily rollup**, both
beside the duration and on the closed button, because past that only the
daily figures survive. The longest range the API accepts is **400 days**.

| Break down by | Shows |
|---|---|
| **Cluster** | The whole cluster as one line, in and out |
| **Node** | One line per node, or a single node's own NIC |
| **Tenant** | One line per tenant, or one tenant in both directions |
| **Pod** | Every pod, or one tenant's pods once a tenant is chosen |
| **Ingress route** | One line per route |

Metrics are **Traffic** (bytes), **Requests**, and **Avg latency**. Requests
and latency are not offered for pods: Traefik counts per backend *service* and
cannot know which pod replied. Asking for them anyway returns an error saying
so rather than a flat zero line.

### What a route is named

A route row is named for its **domain and the tenant that owns it**. Where
that is not knowable it is named for the tenant and the ingress object
instead, never for a guessed domain.

The limit is in the measurement, not the naming. Traefik counts per backend
*service* and its counters carry no host: a tenant gets one ingress object
holding all of its routes, and Traefik mints one service per route inside
it, told apart by a hash of the match rule that cannot be turned back into a
hostname. So a service maps to a domain exactly when the tenant serves one
host — then every service of theirs serves it. Tenants with several hosts
keep object naming. Rows that cannot be told apart at all are numbered.

### Two measurements that share a name

Cluster and node traffic is the **host's own NIC**. Tenant and pod traffic is
the **pod's own interface**. They do not add up to each other and are not
meant to — a tenant is billed for what their pods moved, not for a share of
the host, and no per-pod arithmetic can recover host-network traffic.

Cluster traffic shows **both**, under headings that say which is which,
rather than blending them into one number that would be wrong:

| Heading | Rows | Adds up? |
|---|---|---|
| **At the wire — what crossed the network** | `Inbound (wire)`, `Outbound (wire)` | Yes — this is the total |
| **Part of that same total, seen another way** | `Node-to-node (in/out)`, `Off-site backup upload` | No — already inside the wire total |
| **What each workload sent — counted at the pod, not the wire** | `Tenant workloads sent`, one row per backup class | No — see below |

The workload rows do not decompose the wire, and the page does not pretend
they do. A backup travels job → in-cluster relay → off-site, so its bytes are
counted twice there; traffic between two pods on the same node never reaches
the NIC at all. They are kept because they are the only per-class detail
there is. **Share** is therefore computed within a heading, never across all
three.

Nothing here is tied to an interface called `eth0`. A node whose NIC is
`ens3`, `enp1s0`, `eno1`, `bond0` or a bridge is measured exactly the same
way.

### Reading the chart

- **Hover the plot** for an exact reading. The card is pinned to the top-left
  and appears only while the pointer is over it.
- **Orange markers** flag spikes; click one to zoom to it.
- **Click a row** in the summary table to hide that series. It stays listed,
  dimmed, so you can put it back — and the summary tiles above the chart
  recalculate from what is left, so they always describe the chart you are
  looking at.
- **The trend column** in the summary table sparks each row's own shape, so a
  row that is flat and a row that spiked are distinguishable without hiding
  the others.
- **A gap is a gap.** An unmeasured interval breaks the line instead of
  dropping to zero — a scrape that did not happen is not an hour of silence.
- Times are shown in **your own timezone**.

### Backups

Backups the platform schedules run inside the tenant's namespace, so their
upload looks like any other egress. On a cluster traffic view they are
**always shown separately** — there is no control to fold them back in. How
much of the cluster's egress is the platform backing itself up is something
you need every time you read this page, not only when you remember to ask
for it.

| Class | What it is |
|---|---|
| **Backup · tenant bundles** | A tenant's whole bundle. Files and mailboxes are two *components* of one bundle, alongside config and secrets — so they are one class, not two |
| **Backup · mail server snapshots** | The mail server's own snapshots — a different job from a tenant's mailbox component |
| **Backup · databases** | Postgres base backups and WAL archiving |
| **Backup · cluster state & secrets** | The cluster-state and secrets backups |

If nothing was backed up in the range, the page says so rather than leaving
you to wonder whether the split is broken.

This egress is **not billed to the tenant** — see
[Tenant backups](tenant-backups.md). The tenant's own Monitoring page does not
draw it, because it would contradict the allowance shown above the chart.

### Retention

Detailed metrics are kept for **30 days**. Beyond that only the per-tenant
daily egress rollup survives, and the page says which regime it is in: a
wider request at any other breakdown is served short, and says so, rather
than padding the missing months with zeroes.

## Dead pod records

The **Pods** tab lists every pod on the cluster, including ones that have already
finished. A completed or failed pod is kept as a *record* — its name, the node it
ran on, why it stopped — after the workload itself is gone. That is deliberate:
it is what you read when you want to know what happened.

What surprises people is that Kubernetes never clears them. It only collects
terminal pods once there are more than 12,500 of them, which on a cluster this
size is never, so they accumulate: every node reboot leaves a batch and nothing
takes them away again.

They are cheap, but not free:

- They use **no** CPU, memory, or scheduling capacity, and they do not count
  against a tenant's quota. Nothing is starved by leaving them.
- They **do** hold their container logs on the node until the record itself is
  deleted. On one production cluster, 43 records from a single reboot were
  holding about 100 MB.

Two controls sit above the pod list:

- **Prune Dead Pods** removes every completed and failed record now.
- **Auto-prune after N days** removes them once they reach that age, checked a
  few times a day. The default is 30 days, which keeps a month of history for
  post-mortems. Set it to `0` to switch automatic pruning off and keep records
  until you clear them yourself.

Pruning never touches a running or pending pod, and it deliberately leaves alone
any record belonging to a job that has not finished — a job counts its successful
pods, so deleting one would make it repeat the work. When that happens the result
message says so.

!!! note "Not the same as the node-level clean-up"
    The **Clean stale pod records on this node** action on the Node Health tab is
    a narrower, node-scoped tool: it only removes *failed* and *evicted* pods, and
    it refuses tenant and database pods entirely. Records left by a normal
    shutdown are *completed*, not failed, and most of them live in tenant
    namespaces — so that action will not clear them. Use the Pods tab for those.

## Workloads that stop running

A tenant's applications can be completely unreachable while every component
around them reports healthy. The namespace exists, the storage volume is `Bound`
and `attached`, the node is `Ready`, nothing has been OOM-killed, no volume is
full — and the tenant's site serves nothing. Namespace integrity only audits
whether the objects are *present*, so it finds nothing to say.

The platform therefore watches the one thing that answers the question directly:
**does each workload have the replicas its own spec asks for?** A reconciler
sweeps every tenant every five minutes and compares them.

### The grace window

A workload short of its replicas opens an *episode*, but nothing acts on it for
**eight minutes**. A rolling update, a cold image pull and a storage volume
re-attaching all look exactly like "down" for a few seconds, and none of them is
a fault. Only an outage that outlives the window is treated as one — which is
also why the dashboard card stays absent during routine churn.

### Automatic recovery, and what it will not attempt

Past the window the platform tries to fix it before telling you. The action is a
controlled re-stage of the tenant's storage: scale every consumer of the volume
to zero, wait for it to detach fully, then scale back up and confirm the replicas
actually return. That clears the two faults it can clear — a stuck mount whose
staging directory the kubelet retries forever without ever repairing, and a
volume wedged mid-attach — and it lets a still-terminating pod release the memory
it is holding against the namespace quota, which is a common reason a restore
cannot fit yet.

It is bounded: at most three attempts, backing off 10 minutes, 40 minutes, then
160 minutes.

It is also **gated on the cause**, because the tenant's volume is single-writer:
re-staging it means briefly taking down the workloads in that namespace that are
still healthy. That price is worth paying to clear a stuck mount. It buys nothing
for a container image that cannot be pulled, a container crash-looping on
startup, or a pod no node can schedule — each of those comes back in exactly the
same state. Those causes are reported to you immediately instead, with no
disruption attempted.

A recovery attempt is a real storage operation: it appears in the tenant's
operations list as `autoheal`, and it holds the tenant's storage lock while it
runs, so an operator resize or restore started at the same moment is refused with
a clear conflict rather than colliding with it on the same volume.

### When recovery fails

Only then are you alerted — `Tenant workloads down, auto-heal failed`, on every
out-of-band channel. Alerting before the platform has tried teaches people to
ignore the alert; alerting without saying whether it tried sends them to look in
the wrong place. The notification names the workload, the cause in plain language,
how many recovery attempts were made, the error from the last one, and what to go
and do about that specific cause.

The tenant is told too, in their own panel, in terms they can use: their
application is not running, automatic restart did not succeed, and operators have
already been alerted — so they do not need to report it.

### Recovering a tenant parked at zero replicas

If a storage operation scales a tenant down and never brings it back, the
platform can restore it without guessing. When a workload is scaled to zero for
an operation, the replica count it had is recorded on the workload itself, next to
the marker saying it is being held. Recovery reads that back, so it restores the
right workload to the right number — it does not have to infer which past
operation was responsible, which is a guess that gets worse the longer ago it was.

If that record is missing — a workload parked by an older release — the platform
falls back to the replica snapshot stored on the tenant's operations, but only
after checking that the snapshot actually covers the workloads currently stranded.
A snapshot covering only some of them is refused rather than used to restore a
subset, because a partial restore leaves the tenant down while reporting success.
If nothing covers them, the holds are released so normal auto-start works again
and you are told what could not be recovered and why.

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
  (refuses tenant + database pods; zero risk). It is **suggested automatically
  whenever the node actually has stale records**, which is the usual state after
  a reboot: a scheduled job that fires before its dependencies are up leaves a
  Failed pod behind, and a reboot produces neither the evictions nor the
  disk/memory pressure that used to be required for the action to be offered.
  Restart *counts* on healthy pods are not stale records — they are a history of
  the reboot and are neither clearable nor a problem.
- **Restart Longhorn CSI plugin on this node** — re-registers the storage driver
  when a baseline driver is missing.
- **Recycle a specific system pod** — deletes a pod with runaway storage so its
  controller reschedules it and the writable layer is reclaimed.

The same severity badge appears on the node's card under **Cluster → Nodes**
(see [Nodes & cluster](nodes-and-cluster.md)). Use **Reconcile now** to force a
fresh check instead of waiting out the 5-minute tick.

### Memory events

Below the node table, a **Memory events** card lists every memory incident of
the last 30 days — the node running out of memory, kubelet **pod evictions**,
and containers **OOM-killed** — with the node, the workload hit, and when.

Each row says only what is known. The platform reads the kernel's own
out-of-memory counters for every pod, so a killed container is labelled:

| Label | Meaning |
|---|---|
| **OOM at memory limit** | the kernel confirms the pod hit its own memory limit |
| **OOM (node out of memory)** | the node ran out of memory and the kernel picked this container — raising its limit will not help |
| **OOM-killed** | the kubelet reported an OOM kill; limit vs node could not be determined |
| **SIGKILL, cause unconfirmed** (grey) | the container was killed (exit 137) and there was no evidence either way |

A container that was killed for a reason the kernel shows was **not** memory
(it exited 137 on its own, a liveness probe, a rollout) does not appear at all.
Evictions are labelled with what the kubelet ran short of — **memory**,
**disk** or **PID** pressure — or **storage limit** when a pod exceeded its own
ephemeral-storage limit (an eviction on a healthy node).

The platform is engineered so that under memory pressure **tenant workloads
are always sacrificed before system workloads** (priority tiers + kubelet
eviction headroom on every node), so the card doubles as a verdict: amber
tenant rows are the designed backpressure at work; a red **SYSTEM** row means a
platform component lost a fight it should never lose — investigate.

Admins get one notification per event, in the category that matches it:
**Tenant pods evicted** and **Node out of memory / SYSTEM pod evicted** for
evictions and node-level OOMs (grouped per node per hour), **Tenant workload
OOM-killed** and **Platform workload OOM-killed** once per container kill. Two
SLO rules back this at the metrics layer: **Kernel OOM killer fired** (warning)
and **SYSTEM container OOM-killed** (critical).

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
| **Sources** | What triggers a notification — per-event (security, subscription, tenant lifecycle, backups, node health, node memory events, bandwidth, mail health…), with default channels and rate limits |
| **Providers** | The transports that deliver them (SMTP relays today — your own Stalwart, Postmark, Brevo, …) |
| **Templates** | Operator-editable Handlebars templates per source/channel/locale |
| **Delivery Log** | Per-channel delivery outcomes, for audit and triage |

Node-health transitions, backup failures, security-hardening drift, and tenant
lifecycle events all flow through here — as do the resource and mail alert
families:

- **Bandwidth** — tenants and admins are told at 80/90/100% of a tenant's
  monthly allowance; at 100% the tenant's sites soft-switch to a maintenance
  page ([details](../admin/plans-and-subscriptions.md#the-monthly-bandwidth-cap)).
- **Tenant resource saturation** — a tenant sitting at ~90%/100% of its CPU,
  memory, or storage allocation alerts the admins (time to upsell or resize
  before things break).
- **Node CPU** — sustained node-level CPU saturation fires warning/critical
  SLO alerts.
- **Node memory events** — SystemOOM / evictions / OOM-kills, see
  [Memory events](#memory-events) above.
- **Mail health** — outbound send-abuse saturation, mailbox quota, the mail IP
  appearing on a DNS blocklist, and certificate expiry all reach you as
  notifications, not just as panel banners
  ([mail operations](mail-operations.md)).
- **Tenant workloads down** — a tenant's applications have been unavailable past
  the grace window *and* automatic recovery could not bring them back. Sent
  out-of-band by design: an availability alert must never depend only on the
  panel it is reporting on, so it does not appear in the in-app bell — the
  dashboard card is its in-panel surface. See
  [Workloads that stop running](#workloads-that-stop-running).

Each source can be enabled, disabled, and routed independently. Email is sent
asynchronously, so a slow relay never blocks the platform.

### Reading a notification

Open the **bell** in the top bar to see recent notifications. Each one is
**clickable** — selecting it marks it read and takes you straight to the page
where you act on it: an SLO alert opens **Monitoring**, a node alert opens
**Cluster → Nodes**, and a tenant-specific alert (OOM, resource saturation,
bandwidth, a failed custom deployment) opens **that tenant's** page rather than
the full list. Alert values are shown in the metric's own units — a percentage
(`3.87%`), a duration (`620ms`, `1.1d`), or a plain count — never a raw ratio.

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
