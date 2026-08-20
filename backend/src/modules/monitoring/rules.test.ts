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
    expect(describeSubject(ruleById('api-latency-p95')!, {})).toBeNull();
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
