# Monitoring & Observability

The deployed observability stack (ADR-051, resolves roadmap R2) is built
around **one pod** plus the platform's own modules:

| Pillar | Tool | Memory | Notes |
| --- | --- | --- | --- |
| Metrics (scrape + TSDB + query + UI) | **VictoriaMetrics vmsingle** (`k8s/base/monitoring/`) | 128Mi req / 384Mi limit | Built-in scraper — no vmagent. The limit is held by THREE budgets, not one — see [Memory budget](#memory-budget) before changing any of them |
| Alerting | **platform-api `monitoring` module** | 0 (in-process) | 60s evaluator → existing notification channels (email + in-app) |
| Object/state health | Built-in `node-health` / `cluster-health` modules | 0 (existing) | K8s-API-driven; node DiskPressure alerts live HERE, not in PromQL |
| Ad-hoc exploration | **VMUI** at `https://admin.<apex>/metrics/vmui/` | 0 (inside vmsingle) | Path route on the admin host (no own subdomain/cert); admin-cookie gated (`insula.host/admin-ui` label, CI-enforced) |
| Dashboards | Admin panel → Monitoring → SLOs tab | 0 (existing panel) | Panel-ID-keyed query proxy; no arbitrary PromQL from the browser |
| Logs | **none (deferred)** | — | journald capped at 2G/node + kubelet rotation + `kubectl logs`; revisit on concrete need (ADR-051) |

The kube-prometheus-stack + Loki helm path that used to hide behind
`--with-monitoring` was removed 2026-06-12 (the flag is now a deprecation
no-op). If a cluster ever ran it: `helm uninstall kube-prometheus -n
monitoring && helm uninstall loki -n monitoring` — do **not** delete the
`monitoring` namespace; it now hosts vmsingle.

## Scrape targets

All targets are endpoints that already exist — no exporter sidecars, no
node-exporter, no kube-state-metrics:

| Job | Target | Feeds |
| --- | --- | --- |
| `kubelet-cadvisor` | every node :10250 (SA bearer token) | node/container CPU + memory (hard `keep` allowlist — see below) |
| `kubelet-resource` | every node :10250 | per-pod resource usage |
| `traefik` | traefik pods :9100 | request rate / 5xx ratio / latency (availability + platform-latency SLOs) |
| `cert-manager` | controller :9402 | certificate expiry + readiness |
| `longhorn` | longhorn-manager :9500 | per-node storage capacity/usage (headroom SLO) |
| `flux` | controllers :8080 | reconcile errors |
| `cnpg` | system-db pods :9187 | postgres up / replication lag (PodMonitor CRD deliberately unused) |
| `coredns` | kube-system :9153 | DNS health |
| `platform-api` | :9090 (phase 2) | HTTP histogram, ACME order/renewal counters, mail TLS expiry, Stalwart task-queue depth |

**Cardinality rule:** `kubelet-cadvisor` and `traefik` are the jobs whose
series count grows with tenant count. Their `metric_relabel_configs` in
`k8s/base/monitoring/scrape-config.yaml` are hard allowlists — extend them
deliberately per-metric, never wholesale. Check the live series count via
VMUI → `/api/v1/status/tsdb` after changes.

For `traefik` specifically: `traefik_service_*` carries a per-backend-service
label, so it scales with tenant workloads. The `_bucket` family is kept ONLY
for `platform-*` and `mail-*` services — a fixed-size set, since tenant
namespaces are always `tenant-*` — and dropped for the rest. That is what lets
the `platform-latency-slow-share` SLO measure the platform's own surfaces
without scoring tenant websites. Tenant `_sum`/`_count` survive, so per-service
average latency stays available for every tenant.

**envsubst warning:** Flux postBuild runs envsubst over the rendered
scrape config. Relabel `replacement` fields must use `$1`, never `${1}`
(`ci-flux-envsubst-check.sh` guards the class).

## Adding a scrape job

1. Add the job to `k8s/base/monitoring/scrape-config.yaml` (pod-role SD +
   label `keep` + `__address__` port rewrite — copy an existing job).
2. If the target namespace has a default-deny ingress netpol, add an
   allow for `namespaceSelector kubernetes.io/metadata.name: monitoring`
   scoped to the metrics port only (example: the :9187 rule in
   `k8s/base/network-policies.yaml`).
3. vmsingle re-reads the config every minute
   (`-promscrape.configCheckInterval=1m`) once the kubelet has synced
   the ConfigMap (worst case ~2 min total; or delete the pod). Verify
   at `https://admin.<apex>/metrics/targets`.

## Alerting (platform-api `monitoring` module)

- The default SLO rule pack lives in code
  (`backend/src/modules/monitoring/rules.ts`), derived from
  `docs/roadmap/SLI_SLO_DEFINITION.md`: availability burn rates,
  platform-surface latency, cert expiry (<14d), Longhorn headroom (80/90%), node memory
  (90/95%), CNPG up + replication lag, Flux reconcile errors,
  scrape-target down, ACME order failures.
- A 60s evaluator (HA-deduped across the 3 platform-api replicas via a
  single-row DB lease claim) queries vmsingle; alert-state transitions
  persist to `alert_state` and notify admins through the standard
  notification channels with the node-health 24h re-fire throttle.
- **Who watches the watcher:** after 3 consecutive query failures the
  evaluator raises a synthetic `monitoring-unreachable` critical through
  the same (VM-independent) notification path.
- Per-rule threshold overrides / disables: `monitoring_rule_overrides`
  (admin API) — the pack itself ships with each release.
- Node **disk** is intentionally absent from the PromQL pack: kubelet
  `DiskPressure` alerts come from the node-health module; the Longhorn
  headroom rule covers data disks. Don't add node-exporter to "fix" this.

### Latency alerting: why it is a share, not a percentile

`platform-latency-slow-share` fires when **more than 5% of requests to the
platform's own surfaces took over 1.2s, and at least 10 of them did**, for 15
minutes. It replaced `api-latency-p95` (retired 2026-09-12), which paged on a
p95 over the whole ingress and was noise 18.8% of the week on production.

Three properties are deliberate, and a future "improvement" that drops any of
them brings the noise back:

- **Scoped to `platform-*`/`mail-*` services.** A tenant's slow app is that
  tenant's problem and belongs on their health page. The retired rule scored
  every tenant website into one number, and 103 of 107 slow requests in the
  hour that was sampled were a single tenant's Nextcloud DAV sync.
- **An absolute floor alongside the ratio.** Platform surfaces see a median of
  6 requests per 30 minutes. Any pure ratio — including a percentile — turns
  one slow request into a page at that volume.
- **A share, not a percentile.** `histogram_quantile()` between two bucket
  edges is interpolation, so a p95 reported to the millisecond is arithmetic
  rather than measurement. A count of requests past a bucket edge is exact.

If the alert fires, the usual cause is platform-api waiting on Postgres —
check the API pods and `system-db` before the panels.

## External service health checks (ADR-022)

Unchanged — these live in platform-api, not PromQL, because they degrade
gracefully and gate platform behavior:

| External Service | Health Check | Degradation Behavior |
|-----------------|-------------|---------------------|
| **PowerDNS API** | reachability probe | DNS zone/record ops queue; existing domains keep working |
| **OIDC Provider** | `/.well-known/openid-configuration` | existing tokens keep working; new logins fail; JWKS cache (1h TTL) |
| **NetBird Mesh** | management API probe (if configured) | admin access unaffected; new peer enrollment fails |

## Storage & retention

- PVC `vmsingle-storage`: **2Gi**, `longhorn-system-local` (1 replica —
  metric history is recreatable; alert state lives in the platform DB).
- `-retentionPeriod=30d`; expected usage 0.5–1GB at current series count
  (~10–15k series @60s ≈ 15–30MB/day compressed).
- `-storage.minFreeDiskSpaceBytes=200MB`: vmsingle flips ingestion
  read-only (queries keep working) instead of crashing on a full disk;
  the scrape/ingestion alerts surface it.
- Reset/recovery: delete the PVC and the pod — vmsingle re-scrapes from
  scratch. You lose charts, never platform state.

## Memory budget

vmsingle lives in **384Mi**, and three separate budgets keep it there. Changing
one without the others is how it got OOM-killed every ~2 days on the production
cluster until 2026-08-30.

| Budget | Setting | Covers |
| --- | --- | --- |
| VM caches | `-memory.allowedBytes=64MiB` | fastcache — anonymous mmap **outside** the Go heap |
| Go runtime | `GOGC=40`, `GOMEMLIMIT=192Mi` | heap + runtime; cannot see the caches |
| Ingest volume | `metric_relabel_configs` in `scrape-config.yaml`, then read-driven ingestion (below) | series never stored at all |
| CPU count | `GOMAXPROCS=2` | write buffers, which vmsingle sizes per CPU core |
| Uptime | `recycler` sidecar, `RECYCLE_AT_UTC=22:30` | memory that grows with how long the process lives |

### Read-driven ingestion

vmsingle's memory follows the number of active series, so the platform stores
only what something **reads**, in the shape it reads it. Before this, 39–64% of
active series (measured on two clusters) had no reader, and the read families
carried per-container and per-status-code dimensions 6–200× beyond what any
query uses — all of it growing with every container, volume, database replica
and tenant route. Filtering by reader instead of capping series keeps every
panel, rule and chart intact; series then scale with what the platform shows
(nodes, tenant routes, pods' traffic).

| File | What it does |
| --- | --- |
| `k8s/base/monitoring/read-driven-relabel.yaml` (`-relabelConfig`) | keeps the READ families plus a small vmsingle self-diagnosis set; drops per-container CPU/memory/OOM series outside what the rules read |
| `k8s/base/monitoring/streamaggr-config.yaml` | sums Traefik's per-code/method counters to `service, node` (or `entrypoint, code`) before storage |
| `backend/src/modules/monitoring/read-driven-ingestion.test.ts` | fails the build when a backend query reads a family or label that is not stored, or when a family is kept that nothing reads |

**Adding a reader.** A new PromQL query in the backend needs its metric family
in the READ list of `read-driven-relabel.yaml`, and every label it filters on
must survive (not be dropped, not be aggregated away in `streamaggr-config.yaml`).
The test names the missing family and the file that reads it.

**Exploring beyond what the platform reads.** Operators who use VMUI or an
external Grafana for ad-hoc analysis can include the opt-in component in their
overlay; it stores everything again, at the memory cost this policy avoids:

```yaml
components:
  - ../../components/monitoring-full-metrics
```

Both files are read when vmsingle starts, so a change takes effect at the next
daily recycle (below), a rollout, or deleting the pod.

**Still growing with cluster size, by design or not yet addressed:** per-pod
network series (the traffic charts show traffic per pod), and the scraper's
per-target memory — vmsingle keeps each target's last raw response
(compressed) to emit staleness markers, sized by the response *before* any
relabeling, so it grows with the number of nodes and their container count.
`-promscrape.noStaleMarkers` would remove it; not enabled, because it changes
how a vanished series ends in queries.

### Two terms that do not depend on load

Neither the cache flags nor `GOMEMLIMIT` see these, and both used to make the
footprint differ between installs running the same workload.

**Write buffers scale with the node's CPU count.** vmsingle keeps an 8 MiB
buffer per CPU shard for each monthly partition it writes to, and keeps it
until that partition ages out of retention (v1.148.0
`lib/storage/raw_row.go`). The pod has no CPU limit, so the shard count was the
node's core count: 64 MiB on 8 cores, 256 MiB on 32 — and twice that once the
process lives across a month boundary. On DEV (4 cores) the heap floor stepped
68 → 101 MiB at 00:00 UTC on the 1st. `GOMAXPROCS=2` makes it 16 MiB (32 across a
boundary) everywhere; vmsingle honours an explicit `GOMAXPROCS`. Two cores are
far more than this workload uses. Raise it in an overlay patch only if a very
large cluster shows ingestion or query latency — each step costs 8 MiB per
partition.

**Some memory grows with uptime alone.** At constant series count and constant
scrape targets, the live heap still rose 1.8–3.8 MiB/day (DEV over 7 days, and
one production run over 17), not yet attributed to a structure. The `recycler`
sidecar bounds it — and the month-boundary buffers, and whatever else
accumulates — by restarting vmsingle gracefully once a day. It sends SIGTERM;
vmsingle flushes every in-memory row to disk and exits 0, and the kubelet
restarts the container in place (same pod, volume and node). The cost is one
scrape interval without samples per day; stored data is kept. The pod's restart
counter rises by one per day, with last state `Completed`, exit 0 — not an OOM.

Configure it with `RECYCLE_AT_UTC` on the `recycler` container, `HH:MM` in UTC,
or `off`:

```yaml
# overlay patch (strategic merge — containers and env merge by name)
apiVersion: apps/v1
kind: Deployment
metadata: { name: vmsingle, namespace: monitoring }
spec:
  template:
    spec:
      containers:
        - name: recycler
          env:
            - name: RECYCLE_AT_UTC
              value: "03:00"   # or "off"
```

The default 22:30 is chosen for every install, not one cluster: at 23:00 UTC
vmsingle pre-builds the next day's per-day index entry for every active series,
the heaviest index work of its day, and this way it runs on a fresh process.
A bad value is reported in the sidecar's log and disables recycling; the sidecar
never exits on its own.

`GOMEMLIMIT` is **derived**, not chosen. It must leave room for everything in
the cgroup that the Go runtime cannot see:

```
384 MiB cgroup limit
− 126 MiB fastcache (off-heap anonymous mmap; measure it, do not assume)
−  ~40 MiB binary, goroutine stacks, slab, slack
= ~218 MiB available to Go   →   GOMEMLIMIT 192Mi
```

Set to 256Mi it is worse than useless: 256 + 126 ≈ 382 MiB, i.e. the backstop
sits *at* the OOM point and the kernel always wins first. Re-derive whenever
`vm_cache_size_bytes` changes materially.

**Why the original single budget failed.** `-memory.allowedBytes=192MiB` capped
the caches at half the limit, which sounds safe and is not a statement about
total memory: the Go runtime needs the same cgroup. Measured in production —
`go_memstats_heap_sys` 234 MiB holding an 89 MiB live heap, plus ~95 MiB of
off-heap fastcache, for 348 MiB resident against a 384 MiB ceiling. The limit
only held because the caches never claimed what they were permitted:
`storage/tsid` had 13,505 entries in 32 MiB against a 128 MiB ceiling.

**Before changing any of these, measure — do not reason from the flag value.**

```bash
kubectl port-forward -n monitoring deploy/vmsingle 18428:8428 &
M=http://127.0.0.1:18428/metrics/metrics
# What the caches actually hold vs what they have been allocated:
curl -s $M | grep -E '^vm_cache_(entries|size_bytes|size_max_bytes)\{' | sort
# Where the rest of the RSS is:
curl -s $M | grep -E '^(process_resident_memory_bytes|go_memstats_heap_(sys|inuse|released)_bytes|go_memstats_next_gc_bytes)'
# Series count and the worst offenders:
curl -s "$M/../api/v1/status/tsdb?topN=20"
```

**What each lever is actually worth**, measured on DEV before and after the
2026-08-30 change (same workload, ~15.5k series, one pod, no restarts):

| Lever | Effect |
| --- | --- |
| `GOGC=40` | slowed the climb — `next_gc` 127 MiB → 77–111 MiB, and the shape became a GC sawtooth rather than a straight line |
| `GOMEMLIMIT` | **nothing, at first.** It was set to 256Mi, and 256 + 126 MiB of off-heap fastcache ≈ the 384 MiB limit — the backstop sat *at* the OOM point. Re-derived to 192Mi from the measured off-heap total |
| `-memory.allowedBytes` 192→64 MiB | **no change to memory held** — `vm_cache_size_bytes` stayed at ~123 MiB. It lowered the sum of cache *ceilings* from ~530 MiB to ~361 MiB, which bounds the worst case, and nothing else |
| series drops (−29 %) | small; the caches that dominate are floor-bound, not series-bound |

!!! warning "Do not read a plateau off one hour"
    The first version of this table claimed a settled 240 MiB steady state. Ten
    samples over the following hour went
    `159 → 229 → 201 → 226 → 265 → 245 → 261 → 240 → 269 → 292` — a **rising**
    sawtooth that returned to the pre-change baseline. The oscillation is GC
    working; the envelope is what matters. This failure has a 1.6–3.6 day
    period, so anything short of a day of samples cannot distinguish "fixed"
    from "slower".

The obvious inference — "a cache holding far less than its ceiling is
over-allocated, so lower `allowedBytes`" — **is wrong here, and was tried.**
VictoriaMetrics enforces internal floors: `storage/tsid`, `metricIDs` and
`metricName` each sit at 32 MiB whether their ceiling is 128 MiB or 64 MiB.
Treat ~120 MiB of fastcache as a fixed cost of running VictoriaMetrics at all.

If the pod needs to be smaller than that, the lever is storing **less** —
shorter retention, or a harder series cut — not this flag, and not a bigger
limit. `GOGC` trades CPU for memory and this pod has CPU to spare (6m of a 100m
request); do not copy that value to a CPU-bound service.

**Kills may not be labelled as such.** The kubelet reports a cgroup OOM *group*
kill as `{exitCode: 137, reason: "Error"}`, so `kubectl get pod` shows no
`OOMKilled` anywhere. Confirm against the kernel instead:

```bash
journalctl --since '7 days ago' | grep -E 'Memory cgroup out of memory'
cat /sys/fs/cgroup/kubepods.slice/.../memory.events   # oom_kill, oom_group_kill
```

The platform classifies both forms via `backend/src/lib/container-termination.ts`
(guard: `scripts/ci-oom-classification-check.sh`).

## Deep-dive recipe (opt-in, NOT deployed)

For heavy debugging, point throwaway tooling at vmsingle's
Prometheus-compatible API (`http://vmsingle.monitoring:8428`): a local
Grafana container via `kubectl port-forward svc/vmsingle -n monitoring
8428` costs zero cluster memory; kube-state-metrics / node-exporter can
be `kubectl apply`'d temporarily if an investigation truly needs them.
They are deliberately not part of any overlay — see ADR-051.

## Built-in modules (unchanged)

- `metrics` — per-tenant resource usage vs plan limits (metrics.k8s.io);
  also feeds the tenant panel's client-facing usage view.
- `node-health` — 5-min reconciler: pressures, CSI presence, evictions;
  severity transitions notify; recovery actions in the admin panel
  (runbook: `docs/operations/NODE_HEALTH_MONITORING.md`).
- `cluster-health` — deployment/daemonset readiness via the K8s API.
- `notifications` — channel fan-out (email + in-app) with per-category
  recipient configuration; the alert evaluator publishes through it.

## Related documentation

- ADR-051 (`docs/architecture/adr/ADR-051-monitoring-stack-vmsingle.md`)
- SLI/SLO definitions (`docs/roadmap/SLI_SLO_DEFINITION.md`)
- Node health runbook (`docs/operations/NODE_HEALTH_MONITORING.md`)
- Component watch / version pins (`docs/operations/COMPONENT_WATCH.md`)
