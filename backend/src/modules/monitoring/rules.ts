/**
 * Default SLO rule pack (ADR-051 phase 3), derived from
 * docs/roadmap/SLI_SLO_DEFINITION.md and the 2026-06-11 incident set.
 *
 * The pack ships IN CODE so every release carries its alerting; the
 * operator can tweak thresholds / disable rules via
 * monitoring_rule_overrides (admin API) but cannot add new rules there.
 *
 * Evaluation semantics (evaluator.ts): each rule's `expr` must return a
 * value > 0 ("violated") continuously for `forSeconds` before the alert
 * fires. Rules are written so the expression yields the OFFENDING value
 * (ratio, seconds, etc.) when violated and an empty vector / 0 when
 * healthy — the optional `threshold` placeholder `$T` lets overrides
 * re-parameterise without string surgery elsewhere.
 *
 * Deliberate gaps (do not "fix" — see ADR-051):
 *   * node DISK: kubelet DiskPressure is alerted by node-health; the
 *     longhorn-headroom rule covers data disks.
 *   * pod restarts/OOM: cluster-health + node-health own object state
 *     via the K8s API (no kube-state-metrics by design).
 */

export interface SloRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly severity: 'warning' | 'critical';
  /**
   * MetricsQL expression. `$T` is replaced with the effective threshold
   * (default below or operator override) before querying.
   */
  readonly expr: string;
  /** Default threshold substituted for $T (also shown in the UI). */
  readonly threshold: number;
  /** Seconds the violation must persist before firing. */
  readonly forSeconds: number;
}

// 99.5% availability SLO ⇒ error budget 0.5%. Burn-rate multipliers per
// the standard multiwindow guidance (14.4x fast / 6x slow).
export const SLO_RULES: ReadonlyArray<SloRule> = [
  {
    id: 'api-availability-fast-burn',
    name: 'API availability — fast burn',
    description: 'Traefik websecure 5xx ratio over 5m burns the 99.5% error budget at ≥14.4×.',
    severity: 'critical',
    expr: '(sum(rate(traefik_entrypoint_requests_total{entrypoint="websecure",code=~"5.."}[5m])) / sum(rate(traefik_entrypoint_requests_total{entrypoint="websecure"}[5m]))) > $T',
    threshold: 14.4 * 0.005,
    forSeconds: 300,
  },
  {
    id: 'api-availability-slow-burn',
    name: 'API availability — slow burn',
    description: 'Traefik websecure 5xx ratio over 6h burns the 99.5% error budget at ≥6×.',
    severity: 'warning',
    expr: '(sum(rate(traefik_entrypoint_requests_total{entrypoint="websecure",code=~"5.."}[6h])) / sum(rate(traefik_entrypoint_requests_total{entrypoint="websecure"}[6h]))) > $T',
    threshold: 6 * 0.005,
    forSeconds: 1800,
  },
  {
    id: 'api-latency-p95',
    name: 'Ingress p95 latency',
    description: 'p95 request duration through Traefik websecure exceeds the SLO target.',
    severity: 'warning',
    expr: 'histogram_quantile(0.95, sum by (le) (rate(traefik_entrypoint_request_duration_seconds_bucket{entrypoint="websecure"}[5m]))) > $T',
    threshold: 0.5,
    forSeconds: 600,
  },
  {
    id: 'cert-expiry',
    name: 'Certificate expiring',
    description: 'A cert-manager certificate expires within the threshold window (seconds).',
    severity: 'critical',
    expr: '(min(certmanager_certificate_expiration_timestamp_seconds) - time()) < $T',
    threshold: 14 * 86400,
    forSeconds: 3600,
  },
  {
    id: 'cert-not-ready',
    name: 'Certificate not Ready',
    description: 'A cert-manager certificate reports Ready=False.',
    severity: 'warning',
    expr: 'max(certmanager_certificate_ready_status{condition="False"}) > $T',
    threshold: 0,
    forSeconds: 1800,
  },
  {
    id: 'longhorn-headroom',
    name: 'Longhorn storage headroom',
    description: 'A node\'s Longhorn data disk usage ratio exceeds the threshold.',
    severity: 'warning',
    expr: 'max(longhorn_node_storage_usage_bytes / longhorn_node_storage_capacity_bytes) > $T',
    threshold: 0.8,
    forSeconds: 900,
  },
  {
    id: 'longhorn-headroom-critical',
    name: 'Longhorn storage headroom — critical',
    description: 'A node\'s Longhorn data disk usage ratio exceeds the critical threshold.',
    severity: 'critical',
    expr: 'max(longhorn_node_storage_usage_bytes / longhorn_node_storage_capacity_bytes) > $T',
    threshold: 0.9,
    forSeconds: 900,
  },
  {
    id: 'node-memory',
    name: 'Node memory pressure',
    description: 'Node working-set memory ratio (cadvisor root cgroup) exceeds the threshold.',
    severity: 'warning',
    expr: 'max(container_memory_working_set_bytes{id="/"} / on (node) machine_memory_bytes) > $T',
    threshold: 0.9,
    forSeconds: 600,
  },
  {
    id: 'node-memory-critical',
    name: 'Node memory pressure — critical',
    description: 'Node working-set memory ratio exceeds the critical threshold.',
    severity: 'critical',
    expr: 'max(container_memory_working_set_bytes{id="/"} / on (node) machine_memory_bytes) > $T',
    threshold: 0.95,
    forSeconds: 600,
  },
  // Node CPU utilisation — reads the root-cgroup CPU counter + machine_cpu_cores
  // that are ALREADY scraped (cadvisor allowlist) but were previously unused.
  // Zero new scrape cost. Longer forSeconds than memory: short CPU spikes are
  // normal, so alert only on SUSTAINED saturation.
  {
    id: 'node-cpu',
    name: 'Node CPU saturation',
    description: 'Node CPU utilisation ratio (root cgroup rate ÷ machine cores) has been sustained above the threshold.',
    severity: 'warning',
    expr: 'max(rate(container_cpu_usage_seconds_total{id="/"}[5m]) / on (node) machine_cpu_cores) > $T',
    threshold: 0.85,
    forSeconds: 900,
  },
  {
    id: 'node-cpu-critical',
    name: 'Node CPU saturation — critical',
    description: 'Node CPU utilisation ratio has been sustained above the critical threshold.',
    severity: 'critical',
    expr: 'max(rate(container_cpu_usage_seconds_total{id="/"}[5m]) / on (node) machine_cpu_cores) > $T',
    threshold: 0.95,
    forSeconds: 900,
  },
  {
    id: 'cnpg-down',
    name: 'system-db instance down',
    description: 'A CNPG postgres exporter target is not up.',
    severity: 'critical',
    expr: '(count(up{job="cnpg"} == 0) or vector(0)) > $T',
    threshold: 0,
    forSeconds: 300,
  },
  {
    id: 'cnpg-replication-lag',
    name: 'system-db replication lag',
    description: 'CNPG streaming replication lag (seconds) exceeds the threshold.',
    severity: 'warning',
    expr: 'max(cnpg_pg_replication_lag) > $T',
    threshold: 30,
    forSeconds: 600,
  },
  {
    id: 'flux-reconcile-errors',
    name: 'Flux resources not ready',
    description: 'One or more Flux resources (Kustomization / GitRepository) have been Ready=False for 15m+.',
    severity: 'warning',
    // Platform-side gauge, NOT controller_runtime_reconcile_errors_total:
    // Flux handles build/apply failures via status conditions + requeue
    // (never a returned reconciler error), so that counter stays 0 through
    // real failures — proven live on staging 2026-06-12 with an 82-retry
    // failing Kustomization — and v2.1+ exposes no per-resource failure
    // metric. max by (kind) dedupes the per-replica export; clamp_min
    // folds the -1 "probe failed" sentinel to 0 so a collector outage
    // cannot false-fire.
    expr: '(sum(max by (kind) (clamp_min(platform_flux_unready_resources, 0))) or vector(0)) > $T',
    threshold: 0,
    forSeconds: 900,
  },
  {
    id: 'scrape-target-down',
    name: 'Scrape target down',
    description: 'At least one scrape job has a down target.',
    severity: 'warning',
    expr: '(count(up == 0) or vector(0)) > $T',
    threshold: 0,
    forSeconds: 600,
  },
  {
    id: 'acme-order-rate',
    name: 'ACME renewal activity',
    description: 'platform-api fired/forced ACME renewals in the last hour — the LE-order-storm canary (#43). Healthy steady state is ZERO.',
    severity: 'warning',
    expr: 'sum(increase(platform_acme_renewals_total{result=~"fired|forced|error"}[1h])) > $T',
    threshold: 3,
    forSeconds: 0,
  },
  {
    id: 'stalwart-acme-queue',
    name: 'Stalwart AcmeRenewal queue depth',
    description: 'Pending/retrying AcmeRenewal tasks piling up in Stalwart (the 97-task storm shape).',
    severity: 'warning',
    expr: 'max(platform_stalwart_acme_task_queue_depth) > $T',
    threshold: 15,
    forSeconds: 600,
  },
  // ── Mail operation (mail-health-collector + mail-stats gauges) ──────────
  // These read FIRST-PARTY platform-api gauges (published on the already-
  // scraped :9090 /metrics), so no Stalwart scrape job / port change is
  // needed. Each gauge is absent when mail is not deployed, so the rule
  // sees an empty vector and never false-fires on a mail-less cluster.
  {
    id: 'mail-server-down',
    name: 'Mail server unreachable',
    description: 'The Stalwart JMAP mgmt endpoint has been unreachable (platform_mail_server_up==0) — inbound/outbound mail and webmail are affected.',
    severity: 'critical',
    // count(==0) so an absent series (mail not deployed) yields 0, not a fire.
    expr: '(count(platform_mail_server_up == 0) or vector(0)) > $T',
    threshold: 0,
    forSeconds: 300,
  },
  {
    id: 'mail-queue-backlog',
    name: 'Outbound mail queue backlog',
    description: 'Messages are piling up in Stalwart\'s outbound delivery queue (platform_mail_outbound_queue_depth) — delivery is stalled or a tenant is flooding.',
    severity: 'warning',
    // >= 0 filter drops the -1 "probe failed" sentinel so a down server
    // (already covered by mail-server-down) can\'t double-fire here.
    expr: 'max(platform_mail_outbound_queue_depth >= 0) > $T',
    threshold: 500,
    forSeconds: 900,
  },
  {
    id: 'mail-cert-expiry',
    name: 'Mail TLS certificate expiring',
    description: 'The served mail TLS certificate expires within the threshold window (seconds). Reads the platform-served-cert gauge (mail TLS is issued outside cert-manager), which cert-expiry does not cover.',
    severity: 'critical',
    // `>= 0` filter drops the -1 "probe inconclusive" sentinel; the
    // self-signed bootstrap cert reports a year-4096 expiry so it never
    // trips this rule (it has its own mail-cert-self-signed rule).
    expr: 'min(platform_mail_tls_cert_expiry_seconds >= 0) < $T',
    threshold: 14 * 86400,
    forSeconds: 3600,
  },
  {
    id: 'mail-cert-self-signed',
    name: 'Mail TLS certificate self-signed',
    description: 'The served mail TLS certificate is still the rcgen self-signed bootstrap cert — ACME issuance never completed, so external servers reject the TLS.',
    severity: 'warning',
    expr: 'max(platform_mail_tls_cert_self_signed) > $T',
    threshold: 0,
    forSeconds: 1800,
  },
  {
    id: 'mail-mailbox-over-quota',
    name: 'Mailboxes over storage quota',
    description: 'One or more active mailboxes are at 100% of their storage quota (platform_mail_mailboxes_over_quota) — new mail to them is being rejected by Stalwart.',
    severity: 'warning',
    expr: 'max(platform_mail_mailboxes_over_quota) > $T',
    threshold: 0,
    forSeconds: 900,
  },
];

/** Synthetic rule id used by the evaluator when vmsingle is unreachable. */
export const MONITORING_UNREACHABLE_RULE_ID = 'monitoring-unreachable';

export function ruleById(id: string): SloRule | undefined {
  return SLO_RULES.find((r) => r.id === id);
}

/** Substitute the effective threshold into the expression. */
export function renderExpr(rule: SloRule, thresholdOverride: number | null | undefined): string {
  const t = thresholdOverride ?? rule.threshold;
  return rule.expr.replaceAll('$T', String(t));
}
