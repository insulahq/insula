# Monitoring & Observability

The deployed observability stack (ADR-051, resolves roadmap R2) is built
around **one pod** plus the platform's own modules:

| Pillar | Tool | Memory | Notes |
| --- | --- | --- | --- |
| Metrics (scrape + TSDB + query + UI) | **VictoriaMetrics vmsingle** (`k8s/base/monitoring/`) | 128Mi req / 384Mi limit | Built-in scraper — no vmagent |
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
| `traefik` | traefik pods :9100 | request rate / 5xx ratio / latency (availability + p95 SLOs) |
| `cert-manager` | controller :9402 | certificate expiry + readiness |
| `longhorn` | longhorn-manager :9500 | per-node storage capacity/usage (headroom SLO) |
| `flux` | controllers :8080 | reconcile errors |
| `cnpg` | system-db pods :9187 | postgres up / replication lag (PodMonitor CRD deliberately unused) |
| `coredns` | kube-system :9153 | DNS health |
| `platform-api` | :9090 (phase 2) | HTTP histogram, ACME order/renewal counters, mail TLS expiry, Stalwart task-queue depth |

**Cardinality rule:** `kubelet-cadvisor` is the only job whose series
count grows with tenant count. Its `metric_relabel_configs` keep-regex in
`k8s/base/monitoring/scrape-config.yaml` is a hard allowlist — extend it
deliberately per-metric, never wholesale. Check the live series count via
VMUI → `/api/v1/status/tsdb` after changes.

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
  `docs/roadmap/SLI_SLO_DEFINITION.md`: availability burn rates, p95
  latency, cert expiry (<14d), Longhorn headroom (80/90%), node memory
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
