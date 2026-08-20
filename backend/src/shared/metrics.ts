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
 * Mail-server liveness as observed by the platform-api mail-health
 * collector (modules/mail-events/mail-health-collector.ts), refreshed
 * every 60s: 1 = Stalwart JMAP mgmt reachable, 0 = expected-but-
 * unreachable. The gauge is ONLY published when mail is expected (≥1
 * enabled email domain) — on a cluster/dev without mail the series is
 * absent, so the `mail-server-down` rule sees an empty vector and never
 * false-fires. Publishing 0 (not simply dropping the series) on a real
 * outage keeps the alert firing instead of going stale after ~5min.
 */
export const mailServerUp = new Gauge({
  name: 'platform_mail_server_up',
  help: '1 reachable / 0 expected-but-down / -1 unknown (mail not deployed or not yet probed)',
  registers: [metricsRegistry],
});
// CRITICAL: an unlabelled prom-client gauge exports as 0 the moment it is
// registered, even if never .set(). Since 0 is our "down" value, leaving it
// at that default would make `mail-server-down` false-fire on a cluster with
// no mail (or before the collector's first pass). Seed -1 (unknown) so only a
// real probe failure yields 0; the rule matches `== 0` exactly.
mailServerUp.set(-1);

/**
 * Outbound mail queue depth (messages awaiting delivery) from Stalwart's
 * x:QueuedMessage/query total, refreshed with mailServerUp. -1 when the
 * probe couldn't read it (server down) so the backlog rule (which fires
 * on `> $T`) never treats "unknown" as a backlog.
 */
export const mailOutboundQueueDepth = new Gauge({
  name: 'platform_mail_outbound_queue_depth',
  help: 'Outbound mail messages queued for delivery (-1 = unknown/probe failed)',
  registers: [metricsRegistry],
});
// Seed -1 (unknown) rather than the prom-client default 0: the backlog rule
// filters `>= 0`, so an un-probed cluster contributes no sample instead of a
// misleading "0 backlog".
mailOutboundQueueDepth.set(-1);

/**
 * Count of active mailboxes at or above 100% of their storage quota,
 * refreshed by the mailbox quota-threshold pass (mail-stats, ~15min).
 * Feeds the `mail-mailbox-over-quota` rule so an operator sees full
 * mailboxes in aggregate even when the tenant-side owner can't be
 * notified (no mailbox_access rows). Cardinality: a single global gauge,
 * never per-mailbox.
 */
export const mailMailboxesOverQuota = new Gauge({
  name: 'platform_mail_mailboxes_over_quota',
  help: 'Active mailboxes at or above 100% of their storage quota',
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

/**
 * Platform-migration registry health.
 *
 * The registry HALTS on the first failing migration — deliberately, so no later
 * migration runs on a broken base. That behaviour is right; the problem was
 * that it then told nobody. A halted registry emitted one `warn` line into a
 * pod log: no alert, no admin surface, no smoke assertion.
 *
 * The cost of that silence, 2026-08-19: migration 0009 (create the wildcard
 * DNS-01 ClusterIssuers, ADR-058) 403'd because platform-api's ClusterRole had
 * no `create` on clusterissuers. It failed on DEV, then on STAGING, then on
 * production — every tier faithfully rolled out a broken migration and none of
 * them said a word. It surfaced days later as a wildcard certificate that sat
 * "Issuing" forever, because the issuer it referenced had never been created.
 *
 * `id` is the migration that failed, so the alert can name it. A gauge, not a
 * counter: it reflects current registry state and clears when the migration
 * finally applies.
 */
export const platformMigrationFailed = new Gauge({
  name: 'platform_migration_failed',
  help: '1 when a platform-migration failed on the last run (labelled by id); the registry halts here',
  labelNames: ['id'] as const,
  registers: [metricsRegistry],
});

/**
 * Migrations that have not applied yet. Non-zero for longer than a deploy takes
 * means the registry is stuck — either halted on a failure above, or never
 * reached (lock held, skipped).
 */
export const platformMigrationsPending = new Gauge({
  name: 'platform_migrations_pending',
  help: 'Platform-migrations not yet applied (0 on a converged cluster)',
  registers: [metricsRegistry],
});

/**
 * Ingress router health, per panel hostname.
 *
 * 1 = a router matched · 0 = Traefik served its unrouted 404 · -1 = probe failed.
 *
 * Exists because the 2026-08-20 outage was invisible to every other signal:
 * Traefik dropped the routers whose middleware came from a plugin it had
 * failed to download, and pods/certs/Flux all stayed green while both panels
 * 404'd. Refreshed every 60s by modules/monitoring/ingress-router-collector.ts.
 *
 * -1 is NOT a failure state for alerting — a collector outage must not page.
 * The rule keys on `== 0`.
 */
export const ingressRouterUp = new Gauge({
  name: 'platform_ingress_router_up',
  help: 'Panel hostname routes through Traefik (1 routed, 0 no router, -1 probe failed)',
  labelNames: ['host'] as const,
  registers: [metricsRegistry],
});
