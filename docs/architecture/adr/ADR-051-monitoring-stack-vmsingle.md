# ADR-051: Monitoring stack — VictoriaMetrics single-node + in-API alerting

**Status:** Accepted (2026-06-12)
**Resolves:** Roadmap R2 ("Monitoring stack decision + SLI/SLO")

## Context

The platform shipped with two contradictory observability answers:

1. A legacy opt-in `--with-monitoring` bootstrap path installing
   kube-prometheus-stack + Loki via helm — **~1.5–2.5Gi of memory**, not
   Flux-managed, and almost no scrape targets actually wired (Traefik,
   Longhorn, Flux and CNPG metrics were all unconfigured). No cluster ever
   ran it in anger.
2. The built-in `metrics` / `node-health` / `cluster-health` backend modules
   plus the admin Monitoring page — real and deployed, but blind to
   time-series trends and unable to alert on anything the K8s API doesn't
   surface directly.

SLOs existed only on paper (`docs/roadmap/SLI_SLO_DEFINITION.md`). The
2026-06-11 multi-node green-up found three production bug classes (an
ACME order storm rate-limiting Let's Encrypt, runaway platform-fired
snapshot Jobs, orphaned Longhorn volume CRs) purely by manual log/queue
archaeology — every one of them is a one-line PromQL alert.

Constraints: 8Gi server nodes (≈65% used under HA), a 4Gi worker, lean
monthly budget, and the operator's explicit requirement: **as low memory
and storage cost as possible**.

## Decision

One Flux-managed single-pod metrics stack, with alert evaluation inside
platform-api:

1. **VictoriaMetrics single-node (`vmsingle`)** in the `monitoring`
   namespace (`k8s/base/monitoring/`, included by the development +
   production overlays). One pod = scraper (built-in `-promscrape.config`,
   so **no vmagent**), TSDB, PromQL/MetricsQL query API, and the VMUI
   explorer. Requests 128Mi / limit 384Mi (`-memory.allowedBytes=192MiB`).
   PVC **2Gi** on `longhorn-system-local` (single replica), retention 30d:
   ~10–15k series at 60s ≈ 15–30MB/day at VM's sub-byte/sample
   compression; `-storage.minFreeDiskSpaceBytes` flips ingestion read-only
   before a full disk instead of crash-looping.
2. **No Grafana, no Alertmanager, no vmalert, no kube-state-metrics, no
   node-exporter.** Scrape targets are only endpoints that already exist:
   kubelet (cadvisor + resource, bearer-token), Traefik :9100,
   cert-manager :9402, longhorn-manager :9500, Flux controllers :8080,
   CNPG :9187 (scraped directly — the PodMonitor CRD is deliberately
   unused; no prometheus-operator), CoreDNS :9153, and (phase 2)
   platform-api :9090. cadvisor — the only job whose cardinality grows
   with tenant count — carries a hard `keep` metric allowlist.
3. **Alert evaluation lives in platform-api** (`backend/src/modules/
   monitoring/`): a 60s in-process evaluator queries vmsingle, keeps alert
   state in the platform DB, and notifies through the existing
   notification system (email + in-app), reusing the node-health
   severity-transition + 24h re-fire throttle semantics and the
   conditional-DB-claim HA dedup pattern. Zero additional pods. A
   synthetic `monitoring-unreachable` alert (raised after consecutive
   query failures, via a path independent of VM) watches the watcher.
4. **VMUI is exposed admin-gated** at `metrics.${DOMAIN}` behind the
   `admin-auth-cookie` middleware (`insula.host/admin-ui` label — CI
   enforced). The admin panel gets an SLO tab fed by a panel-ID-keyed
   query proxy (no arbitrary PromQL from the browser; VMUI is the ad-hoc
   surface).
5. **Version pin: the VictoriaMetrics LTS line (v1.136.x).** This is a
   deliberate exception to the "latest stable upstream" rule: LTS lines
   get ≥12 months of fixes, which matches the ADR-050 component-watch
   cadence instead of monthly fast-line churn. Tracked in
   `security/components.yaml` with `pin_check: true`.
6. **The legacy `--with-monitoring` helm path is removed** from
   bootstrap.sh (flags remain as deprecation no-ops). Clusters that ever
   ran it uninstall manually (`helm uninstall kube-prometheus loki -n
   monitoring`) — the namespace itself is now Flux-shared, do not delete
   it.
7. **Logs are out of scope** (no Loki/VictoriaLogs): journald is
   platform-capped at 2G/node, container logs rotate via kubelet, and
   `kubectl logs` is adequate at this node count. Revisit only with a
   concrete operator need.
8. **Node disk is intentionally NOT in the rule pack twice**: kubelet
   `DiskPressure` is already alerted by the node-health module; the
   Longhorn headroom rule covers data disks. Do not "fix" this by adding
   node-exporter.

## Memory accounting

| Option | New pods | Memory |
|---|---|---|
| kube-prometheus-stack + Loki (legacy path) | 8–12 | ~1.5–2.5Gi |
| VM "full" stack (vmagent+vmsingle+vmalert+AM+Grafana) | 5 | ~700Mi–1Gi |
| **This ADR: vmsingle + in-API alerting** | **1** | **128Mi req / 384Mi limit** |

## Consequences

- Single replica: node failure or Longhorn reattach = minutes of scrape
  gap and, on disk loss, up to 30d of chart history — never platform
  state (alert state lives in the platform DB). Accepted for the memory
  and storage savings; `monitoring-unreachable` covers the blind window.
- kubelet scraping uses bearer-token authn with
  `insecure_skip_verify: true` (k3s kubelet serving certs aren't
  verifiable from the SA bundle) — the same posture kube-prometheus-stack
  ships on k3s.
- Deep-dive tooling (Grafana, kube-state-metrics, node-exporter) is a
  documented opt-in recipe in `docs/operations/MONITORING_OBSERVABILITY.md`,
  not deployed by default.
- Flux postBuild envsubst gotcha applies to the scrape config: relabel
  `replacement` fields must use `$1`, never `${1}`.

## Rejected alternatives

- **kube-prometheus-stack**: 10–20× the memory for capability this scale
  doesn't use; prometheus-operator CRD machinery (ServiceMonitor /
  PodMonitor) adds moving parts the static+SD scrape config covers.
- **vmalert + Alertmanager**: two more pods and a second
  notification/routing system to operate, duplicating what the platform's
  notification module already does better (channels, audit, in-app).
- **Grafana by default**: ~200Mi for dashboards the admin panel SLO tab +
  VMUI replace at this scale.
- **VictoriaLogs/Loki now**: no current operator need; revisit on demand.
