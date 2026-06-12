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
    name: 'Flux reconcile errors',
    description: 'A Flux controller reported reconcile errors in the last 15m.',
    severity: 'warning',
    expr: 'sum(increase(controller_runtime_reconcile_errors_total[15m])) > $T',
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
