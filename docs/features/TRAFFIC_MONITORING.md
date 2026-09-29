# Traffic Monitoring

Where the bytes went, for whom, and when — in both panels.

- **Admin:** Monitoring → **Traffic** (first tab).
- **Tenant:** **Monitoring** → **Traffic** (the page formerly called Resource
  Usage; `/resource-usage` redirects to its other tab).
- **Dashboard:** a cluster in/out tile in the Platform row.

---

## Two measurements, deliberately kept apart

They share a name and do not share a number.

| Scope | Source | What it means |
|---|---|---|
| Cluster, Node | cAdvisor root cgroup (`id="/"`) | The host's own NIC — what actually crossed the wire, host-network traffic included |
| Tenant, Pod | The pod's `eth0`, inside its netns | What that tenant's workloads moved |
| Ingress route | Traefik service counters | What one route served |

Per-tenant figures do **not** sum to the node figure and are not meant to. A
tenant is billed for what their pods moved, not for a share of the host; and
no per-pod arithmetic can recover host-network traffic.

### Interface names are never hardcoded

Node and cluster queries sum the root cgroup with **no `interface=` filter**.
The scrape config instead drops what is virtual — `cali*`, `vxlan*`, `veth*`,
Calico's own `wireguard.cali`, `docker0`, `br-<hex>`, `lo` — and keeps
whatever is left.

This matters because a NIC is `eth0` on one host and `ens3`, `enp1s0`, `eno1`,
`bond0` or `vmbr0` on the next. A keep-list for `eth0` would silently report
zero node traffic on every other host, and the symptom would be an empty
graph rather than an error. The reference DEV cluster's NIC is `enp7s0`, which
is exactly the case that would have been lost.

`backend/src/modules/traffic/scrape-contract.test.ts` pins this against 21 NIC
spellings and reads the live manifest, so narrowing the rule fails the build.

---

## Metrics

| Metric | Available for | Notes |
|---|---|---|
| Traffic | every scope | Bytes/s, decimal units (as bandwidth is billed) |
| Requests | cluster, node, tenant, route | Traefik request rate |
| Avg latency | cluster, node, tenant, route | A ratio of sums, never a mean of means |

**Not per pod.** Traefik counts per backend *service* and cannot know which
pod replied, so pod scope offers traffic only. Asking anyway returns a 400
that says why, rather than a flat zero line.

---

## What the chart will not pretend

- **A gap is a gap.** An unmeasured bucket is `null`, never `0`; the line
  breaks rather than bridging it. A scrape that did not happen is not an hour
  of silence.
- **A lone measured point is drawn** as a dot, since a run of one has no
  segment to belong to.
- **Latency is never folded into “Other”.** Averaging the tail would invent a
  figure belonging to no service, so the tail is counted and said out loud.
- **A namespace with no tenant record** is labelled as such. Deleted tenants
  leave namespaces that still move bytes; hiding them would drop real traffic
  from the breakdown.

---

## Retention

Fine-grained samples last **30 days** (VictoriaMetrics). Beyond that only the
per-tenant daily egress rollup in `usage_metrics` survives, written by the
bandwidth meter.

A request reaching further back is served one of two ways, and the frame says
which: per-tenant traffic comes from the daily rows at `resolution: 'daily'`;
anything else is **clamped** to what the metrics store still holds, with
`clamped: true`, and the UI says so. Neither pads the missing months with
zeroes.

---

## Backups

Platform-scheduled backup egress runs inside the tenant's namespace and is
**excluded from the tenant's bandwidth meter** (see the FAQ entry on what
counts towards a tenant's allowance).

- **Admin** gets a `Backups` control on cluster scope: *Included* /
  *Separate* / *Only*, splitting by class (tenant files, mailboxes, databases,
  system & secrets) using the same pod-name matchers the meter excludes on.
- **Tenant** has no such control, and the API refuses to split for them. Those
  backups are not billed to the tenant, so drawing them would contradict the
  allowance bar above the chart. A backup the tenant *starts* is theirs, and
  appears normally.

---

## API

```
GET /api/v1/admin/monitoring/traffic/series?from&to&scope&subject&pod&metric&direction&backups
GET /api/v1/admin/monitoring/traffic/subjects?from&to&scope&subject&metric
GET /api/v1/tenants/:id/traffic/series?…
GET /api/v1/tenants/:id/traffic/subjects?…
```

The tenant endpoints take the tenant from the **path**, where
`requireTenantAccess` has already authorised it. A `scope` only an operator
may ask for is a **403**, not an empty chart, and `backups` is always forced
to `included`.

`subject` is handled per scope. For `tenant` and `pod` it is discarded and
replaced by the caller's own namespace. For `route` it is *used* — a route is
addressed by Traefik service, and no service equals the bare namespace — after
being checked against the caller's namespace, including against namespaces
**nested** inside it (`tenant-acme-<hash>` and
`tenant-acme-<hash>-eu-<hash2>` are both legal, and the second begins with
the first). Anything unowned is dropped, falling back to all of that tenant's
routes.

Schemas live in `@insula/api-contracts` (`traffic.ts`).

---

## Cost

Adding inbound collection **reduced** cardinality. cAdvisor attributes one
Calico veth per pod to the root cgroup; on the reference cluster that was 570
of 681 network series. Dropping those and adding `receive` leaves both
directions collected at roughly a third of the previous series count, so no
vmsingle memory budget change was needed — and no node-exporter, since the
root cgroup already reports the host NIC.
