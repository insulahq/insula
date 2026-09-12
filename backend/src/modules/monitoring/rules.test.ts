import { describe, it, expect } from 'vitest';
import { SLO_RULES, ruleById, renderExpr, describeSubject, subjectKey } from './rules.js';

describe('SLO_RULES — mail monitoring additions', () => {
  const MAIL_RULES = [
    'mail-server-down',
    'mail-queue-backlog',
    'mail-cert-expiry',
    'mail-cert-self-signed',
    'mail-mailbox-over-quota',
  ] as const;

  it('registers every new mail rule', () => {
    for (const id of MAIL_RULES) {
      expect(ruleById(id), `rule ${id} present`).toBeDefined();
    }
  });

  it('gives each mail rule a valid severity and a $T-parameterised expr', () => {
    for (const id of MAIL_RULES) {
      const rule = ruleById(id)!;
      expect(['warning', 'critical']).toContain(rule.severity);
      expect(rule.expr).toContain('$T');
      // renderExpr must fully substitute the threshold placeholder.
      const rendered = renderExpr(rule, undefined);
      expect(rendered).not.toContain('$T');
      expect(rendered).toContain(String(rule.threshold));
    }
  });

  it('reads first-party mail gauges (no un-scraped Stalwart metric)', () => {
    expect(ruleById('mail-server-down')!.expr).toContain('platform_mail_server_up');
    expect(ruleById('mail-queue-backlog')!.expr).toContain('platform_mail_outbound_queue_depth');
    expect(ruleById('mail-cert-expiry')!.expr).toContain('platform_mail_tls_cert_expiry_seconds');
    expect(ruleById('mail-cert-self-signed')!.expr).toContain('platform_mail_tls_cert_self_signed');
    expect(ruleById('mail-mailbox-over-quota')!.expr).toContain('platform_mail_mailboxes_over_quota');
  });

  it('mail-server-down folds an absent series to healthy (no false-fire when mail absent)', () => {
    // `or vector(0)` guarantees the count(==0) expr yields 0, not empty,
    // when the gauge series does not exist (mail not deployed).
    expect(ruleById('mail-server-down')!.expr).toContain('or vector(0)');
  });

  it('keeps unique rule ids across the whole pack', () => {
    const ids = SLO_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('SLO_RULES — node CPU', () => {
  it('registers node-cpu and node-cpu-critical against the already-scraped cadvisor CPU metric', () => {
    for (const id of ['node-cpu', 'node-cpu-critical']) {
      const rule = ruleById(id);
      expect(rule, id).toBeDefined();
      expect(rule!.expr).toContain('container_cpu_usage_seconds_total{id="/"}');
      expect(rule!.expr).toContain('machine_cpu_cores');
      expect(renderExpr(rule!, undefined)).not.toContain('$T');
    }
    expect(ruleById('node-cpu')!.severity).toBe('warning');
    expect(ruleById('node-cpu-critical')!.severity).toBe('critical');
    // Sustained-only: CPU spikes are normal, so the window is longer than memory's.
    expect(ruleById('node-cpu')!.forSeconds).toBeGreaterThanOrEqual(600);
  });
});

describe('rules keep the labels that identify what is broken', () => {
  // The defect this guards: every rule aggregated with a bare `max(...)` /
  // `min(...)` / `sum(...)`, which collapses all series into ONE anonymous
  // scalar. `cert-not-ready` was `max(certmanager_certificate_ready_status
  // {condition="False"}) > 0` — the answer is literally `1`, so the alert
  // could never name the certificate, the namespace or the tenant.
  const TOP_LEVEL_AGG = /(?:^|[\s(])(sum|min|max|count|avg|group)\s*(?:by\s*\(([^)]*)\))?\s*\(/g;

  it.each(SLO_RULES.filter((r) => r.subjectLabels.length > 0).map((r) => [r.id, r] as const))(
    '%s aggregates by its subject labels (or not at all)',
    (_id, rule) => {
      TOP_LEVEL_AGG.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TOP_LEVEL_AGG.exec(rule.expr)) !== null) {
        const [, fn, byList] = m;
        // `sum by (le) (...)` inside histogram_quantile is a different beast;
        // those rules have no subject labels and are filtered out above.
        expect(
          byList,
          `${rule.id}: \`${fn}(\` has no \`by (...)\` — it discards ${rule.subjectLabels.join('/')} `
          + 'and the alert cannot say what is affected',
        ).toBeDefined();
        const grouped = (byList ?? '').split(',').map((x) => x.trim());
        for (const label of rule.subjectLabels) {
          expect(grouped, `${rule.id}: ${fn} by (...) drops '${label}'`).toContain(label);
        }
      }
    },
  );

  it('every rule declares subjectLabels (explicitly empty for platform-wide)', () => {
    for (const rule of SLO_RULES) {
      expect(Array.isArray(rule.subjectLabels), `${rule.id} is missing subjectLabels`).toBe(true);
    }
  });

  it('renders a subject naming the certificate and its namespace', () => {
    const rule = ruleById('cert-not-ready')!;
    const label = describeSubject(rule, { name: 'wildcard-tls', namespace: 'tenant-acme' });
    expect(label).toContain('wildcard-tls');
    expect(label).toContain('tenant-acme');
  });

  it('accepts exported_namespace, which is what a relabelling scrape produces', () => {
    const rule = ruleById('cert-not-ready')!;
    expect(describeSubject(rule, { name: 'apex-tls', exported_namespace: 'platform' }))
      .toContain('platform');
  });

  it('gives platform-wide rules no subject rather than an empty one', () => {
    expect(describeSubject(ruleById('platform-latency-slow-share')!, {})).toBeNull();
  });

  it('keys subjects stably regardless of label order', () => {
    const rule = ruleById('cert-not-ready')!;
    expect(subjectKey(rule, { namespace: 'a', name: 'b' }))
      .toBe(subjectKey(rule, { name: 'b', namespace: 'a' }));
  });
});

describe('platform-migration registry alerting', () => {
  /**
   * The 2026-08-19 incident: migration 0009 403'd (platform-api's ClusterRole
   * had no `create` on clusterissuers), the registry HALTED, and DEV, STAGING
   * and production all ran for days against an unconverged base. Nothing
   * alerted; it surfaced as a wildcard certificate stuck "Issuing" because the
   * ClusterIssuer it referenced had never been created.
   */
  it('a failed migration is a CRITICAL rule', () => {
    const r = ruleById('platform-migration-failed');
    expect(r, 'platform-migration-failed rule is missing').toBeDefined();
    expect(r!.severity).toBe('critical');
    // forSeconds=0: a halted registry is not a transient to ride out.
    expect(r!.forSeconds).toBe(0);
  });

  it('names WHICH migration failed, rather than "a migration failed"', () => {
    const r = ruleById('platform-migration-failed')!;
    expect(r.subjectLabels).toContain('id');
    expect(describeSubject(r, { id: '0009_seed_wildcard_dns01_issuers' }))
      .toContain('0009_seed_wildcard_dns01_issuers');
  });

  it('reads the gauge the runner publishes', () => {
    // If these drift apart the rule silently never fires — which is the whole
    // failure mode being fixed.
    expect(ruleById('platform-migration-failed')!.expr).toContain('platform_migration_failed');
    expect(ruleById('platform-migrations-pending')!.expr).toContain('platform_migrations_pending');
  });

  it('also catches a registry that never ran, not just one that failed', () => {
    // A halt is not the only way to end up unconverged: the escape hatch or a
    // stuck advisory lock leave migrations pending with nothing failed.
    const r = ruleById('platform-migrations-pending');
    expect(r).toBeDefined();
    expect(r!.forSeconds).toBeGreaterThan(0); // tolerate a deploy in flight
  });
});

describe('SLO_RULES — platform-surface latency (replaces api-latency-p95)', () => {
  const rule = () => ruleById('platform-latency-slow-share')!;

  it('retires the entrypoint-wide p95 rule outright', () => {
    // Not renamed — RETIRED. Its threshold meant SECONDS and the replacement's
    // means a RATIO, so an operator override carried across the rename would be
    // silently reinterpreted (0.5s → "50% of requests slow", an alert that can
    // never fire). Migration 0109 deletes the old rows for the same reason.
    expect(ruleById('api-latency-p95')).toBeUndefined();
    expect(rule()).toBeDefined();
  });

  it('scores only platform-owned surfaces, never tenant websites', () => {
    // The defect that made the old rule unusable: 103 of 107 slow requests in
    // the sampled production hour were ONE tenant's Nextcloud DAV sync, and the
    // platform operator got paged for it.
    const expr = rule().expr;
    expect(expr).toContain('service=~"(platform|mail)-.*"');
    // The entrypoint histogram aggregates every tenant site into one number and
    // is what made that possible — this rule must not read it.
    expect(expr).not.toContain('traefik_entrypoint_request_duration_seconds');
  });

  it('gates on an ABSOLUTE count of slow requests, not just the ratio', () => {
    // Production serves a median of 6 requests per 30m to platform surfaces.
    // Without a floor, 1 slow request out of 6 is a 16% ratio and clears any
    // threshold — the same near-idle-denominator trap the availability rules
    // grew a floor for.
    expect(rule().expr).toMatch(/>=\s*\d+/);
  });

  it('reports an exactly-measurable value, not an interpolated percentile', () => {
    // histogram_quantile() between two bucket edges is arithmetic, not
    // measurement: the retired rule reported "615ms" from a bucket split that
    // could only prove "somewhere in 0.3s..1.2s". A share-of-requests is exact.
    expect(rule().expr).not.toContain('histogram_quantile');
    expect(rule().unit).toBe('ratio');
  });
});

describe('SLO_RULES — histogram bucket edges must exist', () => {
  // Traefik's DEFAULT latency buckets. scripts/bootstrap.sh configures a wider
  // set (a strict superset) and 2026.9.18/0002 backfills it, but a cluster that
  // has not run that host-migration still exports only these.
  //
  // Selecting an `le` that a cluster does not export yields an EMPTY vector,
  // which sums to nothing, which makes the rule silently unable to fire — a
  // dead alert that looks configured. Every bucket edge a rule keys on must
  // therefore be present in the default set.
  const TRAEFIK_DEFAULT_BUCKET_EDGES = ['0.1', '0.3', '1.2', '5', '5.0', '+Inf'];

  it('keys every le= selector on an edge present in Traefik\'s default buckets', () => {
    const offenders: string[] = [];
    for (const r of SLO_RULES) {
      for (const m of r.expr.matchAll(/le="([^"]+)"/g)) {
        if (!TRAEFIK_DEFAULT_BUCKET_EDGES.includes(m[1])) offenders.push(`${r.id}: le="${m[1]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('actually inspects some le= selectors (the guard is not vacuous)', () => {
    // An empty scan satisfies the assertion above trivially. Prove the pack
    // contains at least one bucket selector for it to have checked.
    const total = SLO_RULES.reduce((n, r) => n + [...r.expr.matchAll(/le="/g)].length, 0);
    expect(total).toBeGreaterThan(0);
  });
});

describe('SLO_RULES — ratios must not mix metric families', () => {
  // Measured on DEV 2026-09-12: with the per-service `_bucket` series freshly
  // created by a scrape-config change while `_count` had months of history,
  // sum(rate(_bucket{le="1.2"}[30m])) exceeded sum(rate(_count[30m])) — rate()
  // extrapolates a young series across a window it does not span. The
  // difference went negative and the ratio evaluated to an empty vector: a rule
  // that CANNOT FIRE, indistinguishable from a healthy one.
  //
  // Any rule dividing one histogram family by another is exposed to this. The
  // le="+Inf" bucket is the same counter as _count by definition, so a
  // same-family quotient is always well-defined and always in [0,1].
  it('never divides a _count series by a _bucket series of the same metric', () => {
    const offenders: string[] = [];
    for (const r of SLO_RULES) {
      if (!r.expr.includes('_bucket')) continue;
      const base = /(\w+?)_bucket/.exec(r.expr)?.[1];
      if (base && r.expr.includes(`${base}_count`)) {
        offenders.push(`${r.id}: mixes ${base}_count with ${base}_bucket`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('checks at least one rule that uses buckets (the guard is not vacuous)', () => {
    expect(SLO_RULES.filter((r) => r.expr.includes('_bucket')).length).toBeGreaterThan(0);
  });
});
