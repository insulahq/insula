/**
 * Prometheus metrics registry (ADR-051, R2 phase 2).
 *
 * One process-wide registry, exposed by plugins/metrics-server.ts on a
 * DEDICATED port (:9090) — never on the authenticated Fastify app, so
 * the F4 invariant (":3000 is reachable from the traefik namespace
 * only") is untouched and the metrics surface needs no auth stack of
 * its own (NetworkPolicy scopes it to the monitoring namespace).
 *
 * Naming: every first-party metric is prefixed `platform_`. Default
 * Node.js process metrics (heap, event loop lag, GC) come from
 * prom-client's collectDefaultMetrics under the same prefix.
 *
 * Cardinality discipline: label values must be BOUNDED. HTTP metrics
 * label on the registered route pattern (`/api/v1/tenants/:id`), never
 * the raw URL; domain-labelled gauges are capped to platform-owned mail
 * hostnames (one per cluster), not tenant domains.
 */
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry, prefix: 'platform_' });

/**
 * HTTP request duration histogram, fed by the onResponse hook in
 * plugins/metrics-server.ts. `route` is Fastify's registered route
 * pattern (bounded); unmatched requests collapse into "unmatched".
 * Buckets skew low — the p95 SLO is 500ms.
 */
export const httpRequestDuration = new Histogram({
  name: 'platform_http_request_duration_seconds',
  help: 'HTTP request duration by route pattern',
  labelNames: ['method', 'route', 'status_class'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * ACME order/renewal activity — the LE-order-storm canary (#43). In a
 * healthy steady state BOTH counters stay flat: the stalwart-domain
 * reconciler's stored-cert + pending-task gates skip every fire, and
 * renewals are Stalwart-scheduled (~30d before expiry). Any sustained
 * slope here means something is hammering Let's Encrypt again.
 *
 * result: fired | skipped_stored_cert | skipped_pending_task | forced | error
 */
export const acmeRenewalsTotal = new Counter({
  name: 'platform_acme_renewals_total',
  help: 'AcmeRenewal fire attempts by the stalwart-domain reconciler',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

/**
 * Seconds until the served mail TLS certificate expires, refreshed by
 * the stalwart-domain reconciler's served-cert probe each tick (30min).
 * -1 = probe inconclusive; rcgen self-signed reports its real (absurd,
 * year-4096) expiry but is also flagged via the companion gauge below.
 */
export const mailTlsCertExpirySeconds = new Gauge({
  name: 'platform_mail_tls_cert_expiry_seconds',
  help: 'Seconds until the served mail TLS certificate expires (-1 = unknown)',
  labelNames: ['hostname'] as const,
  registers: [metricsRegistry],
});

/** 1 when the served mail cert is the rcgen self-signed bootstrap cert. */
export const mailTlsCertSelfSigned = new Gauge({
  name: 'platform_mail_tls_cert_self_signed',
  help: '1 when the served mail TLS certificate is self-signed (bootstrap rcgen)',
  labelNames: ['hostname'] as const,
  registers: [metricsRegistry],
});

/**
 * Pending/retrying AcmeRenewal tasks observed in Stalwart's queue —
 * the 2026-06-11 storm accumulated 97 of these. Refreshed by the
 * reconciler tick (the same x:Task/query the dedup gate performs).
 */
export const stalwartAcmeTaskQueueDepth = new Gauge({
  name: 'platform_stalwart_acme_task_queue_depth',
  help: 'Pending/retrying AcmeRenewal tasks in the Stalwart task queue (-1 = probe failed)',
  registers: [metricsRegistry],
});

/**
 * Count of Flux resources whose Ready condition is False, by kind.
 * Refreshed every 60s by modules/monitoring/flux-status-collector.ts on
 * EVERY replica (the vmsingle scrape is per-pod), each computing the
 * same cluster-wide count; the alert rule aggregates with max by (kind)
 * so replica skew between refreshes is harmless.
 *
 * Why a platform-side gauge: Flux v2.1+ exposes NO per-resource failure
 * metric (gotk_reconcile_condition was removed upstream), and
 * controller_runtime_reconcile_errors_total counts only UNHANDLED
 * reconciler errors — Flux records real build/apply failures in status
 * conditions and requeues, so that counter stays 0 through genuine
 * failures (proven live on staging 2026-06-12: an 82-retry
 * path-not-found Kustomization moved it by exactly 0).
 *
 * -1 = listing that kind failed (clamped to 0 by the alert expression
 * so a collector outage can never false-fire). Suspended resources are
 * excluded — they keep their last Ready condition forever and an
 * operator suspension is not a Flux failure.
 */
export const fluxUnreadyResources = new Gauge({
  name: 'platform_flux_unready_resources',
  help: 'Flux resources with Ready=False by kind (-1 = probe failed; suspended excluded)',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});
