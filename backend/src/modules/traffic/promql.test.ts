import { describe, it, expect } from 'vitest';
import {
  buildTrafficQuery, quoteLabel, serviceMatcherForNamespace, UnsupportedTrafficQuery,
  BACKUP_CLASS_POD_RE, isValidNamespace,
} from './promql.js';

const base = { metric: 'traffic', direction: 'out', stepSeconds: 300 } as const;

describe('node and cluster traffic read the NIC', () => {
  it('scopes to the root cgroup, never to a pod', () => {
    expect(buildTrafficQuery({ ...base, scope: 'cluster' }).expr).toContain('id="/"');
    expect(buildTrafficQuery({ ...base, scope: 'node' }).expr).toContain('id="/"');
  });

  it('NEVER filters on an interface name', () => {
    // A host whose NIC is ens3/enp1s0/bond0 must be summed like one using
    // eth0. Hardcoding a name here would zero those hosts out silently.
    for (const scope of ['cluster', 'node'] as const) {
      const expr = buildTrafficQuery({ ...base, scope }).expr;
      expect(expr).not.toMatch(/interface\s*=/);
      expect(expr).not.toContain('eth0');
    }
  });

  it('groups per node until a node is chosen', () => {
    expect(buildTrafficQuery({ ...base, scope: 'node' }).groupBy).toBe('node');
    const one = buildTrafficQuery({ ...base, scope: 'node', subject: 'sv1' });
    expect(one.groupBy).toBeNull();
    expect(one.expr).toContain('node="sv1"');
  });
});

describe('tenant and pod traffic read the pod', () => {
  it('uses the namespace, not the root cgroup', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'tenant', subject: 'tenant-a-1' }).expr;
    expect(expr).toContain('namespace="tenant-a-1"');
    expect(expr).not.toContain('id="/"');
  });

  it('refuses a pod scope with no tenant', () => {
    expect(() => buildTrafficQuery({ ...base, scope: 'pod' })).toThrow(UnsupportedTrafficQuery);
  });

  it('reads the right counter per direction', () => {
    expect(buildTrafficQuery({ ...base, scope: 'cluster', direction: 'in' }).expr)
      .toContain('container_network_receive_bytes_total');
    expect(buildTrafficQuery({ ...base, scope: 'cluster', direction: 'out' }).expr)
      .toContain('container_network_transmit_bytes_total');
  });
});

describe('backup separation', () => {
  it('excludes every backup class when asked for serving traffic', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'tenant', subject: 'tenant-a-1', backups: 'exclude' }).expr;
    for (const re of Object.values(BACKUP_CLASS_POD_RE)) expect(expr).toContain(re);
    expect(expr).toContain('pod!~');
  });

  it('isolates one class', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'backup-class', backupClass: 'mailboxes' }).expr;
    expect(expr).toContain('pod=~"bk-mbox-.+"');
  });

  it('refuses a backup-class query with no class', () => {
    expect(() => buildTrafficQuery({ ...base, scope: 'backup-class' })).toThrow(UnsupportedTrafficQuery);
  });
});

describe('request-level metrics', () => {
  it('says so plainly when a scope cannot answer', () => {
    // Traefik counts per backend service and has no idea which pod replied.
    expect(() => buildTrafficQuery({ ...base, scope: 'pod', subject: 'tenant-a-1', metric: 'requests' }))
      .toThrow(/not available for pod scope/);
  });

  it('averages latency as a ratio of sums, not a mean of means', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'cluster', metric: 'latency' }).expr;
    expect(expr).toMatch(/^1000 \* sum\(rate\(traefik_service_request_duration_seconds_sum/);
    expect(expr).toContain('/ sum(rate(traefik_service_request_duration_seconds_count');
    expect(expr).not.toContain('avg(');
  });

  it('matches a tenant’s services by namespace prefix', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'tenant', subject: 'tenant-a-1', metric: 'requests' }).expr;
    expect(expr).toContain('service=~"tenant-a-1-.+"');
  });
});

describe('label injection', () => {
  it('escapes quotes and backslashes out of a label value', () => {
    expect(quoteLabel('a"b')).toBe('a\\"b');
    expect(quoteLabel('a\\b')).toBe('a\\\\b');
    expect(quoteLabel('a\nb')).toBe('ab');
  });

  it('cannot be used to break out of the matcher', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'node', subject: 'sv1"} or up{' }).expr;
    expect(expr).toContain('node="sv1\\"} or up{"');
    // one selector, not two expressions
    expect(expr.match(/rate\(/g)).toHaveLength(1);
  });

  it('escapes regex metacharacters so they SURVIVE the string literal', () => {
    // Two layers, and the inner one is easy to get wrong. The regex wants
    // `\.`; a PromQL double-quoted literal unescapes `\.` to `.`, so the
    // literal must carry `\\.` for the regex engine to receive an escaped dot.
    // Escaping once produced a matcher where `.` matched any character.
    expect(serviceMatcherForNamespace('tenant-a.b+c')).toBe('tenant-a\\\\.b\\\\+c-.+');
  });
});

describe('route scope (regressions found in review + on DEV)', () => {
  it('answers a traffic question instead of throwing', () => {
    // This combination is the default selection in both panels and used to
    // fall through networkSelector's `default:` and 400 on every request.
    const q = buildTrafficQuery({ ...base, scope: 'route' });
    expect(q.expr).toContain('traefik_service_responses_bytes_total');
    expect(q.groupBy).toBe('service');
  });

  it('reads Traefik byte counters from the PROXY’s point of view', () => {
    // requests_bytes = what clients sent IN; responses_bytes = what went OUT.
    expect(buildTrafficQuery({ ...base, scope: 'route', direction: 'in' }).expr)
      .toContain('traefik_service_requests_bytes_total');
    expect(buildTrafficQuery({ ...base, scope: 'route', direction: 'out' }).expr)
      .toContain('traefik_service_responses_bytes_total');
  });

  it('confines a tenant to their own services when no route is named', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'route', namespacePrefix: 'tenant-a-1' }).expr;
    expect(expr).toContain('service=~"tenant-a-1-.+"');
  });

  it('selects exactly one service when a route is named', () => {
    const expr = buildTrafficQuery({
      ...base, scope: 'route', subject: 'tenant-a-1-web-abc@kubernetescrd',
    }).expr;
    expect(expr).toContain('service="tenant-a-1-web-abc@kubernetescrd"');
    expect(expr).not.toContain('=~');
  });
});

describe('label escaping closes the string literal, not only the regex', () => {
  it('escapes a quote out of a namespace service matcher', () => {
    // Escaping regex metacharacters alone left `"` free to end the PromQL
    // string literal and start a second label matcher.
    const m = serviceMatcherForNamespace('tenant-x", job=~".+');
    expect(m).not.toMatch(/(^|[^\\])"/);
  });

  it('cannot add a second matcher through the route confinement', () => {
    const expr = buildTrafficQuery({
      ...base, scope: 'route', namespacePrefix: 'tenant-x", job=~".+',
    }).expr;
    expect(expr.match(/rate\(/g)).toHaveLength(1);
    expect(expr.match(/service=~/g)).toHaveLength(1);
    // The injected text may still be PRESENT — it is just inert, sitting
    // inside the string literal. What matters is that every quote between
    // the delimiters is escaped, so the literal ends where we put its end.
    const inner = /service=~"((?:[^"\\]|\\.)*)"/.exec(expr);
    expect(inner, 'the matcher must parse as one complete string literal').not.toBeNull();
    expect(expr.slice(expr.indexOf(inner![0]) + inner![0].length)).not.toContain('job=');
  });

  it('accepts a real namespace and refuses a shaped-but-invalid one', () => {
    expect(isValidNamespace('tenant-alpha-example')).toBe(true);
    expect(isValidNamespace('tenant-x", job=~".+')).toBe(false);
    expect(isValidNamespace('Tenant-Upper')).toBe(false);
    expect(isValidNamespace('-leading-hyphen')).toBe(false);
    expect(isValidNamespace('a'.repeat(64))).toBe(false);
  });
});

describe('pod grouping', () => {
  it('groups by pod whether or not a pod is named', () => {
    // Used to be a ternary with two identical branches.
    expect(buildTrafficQuery({ ...base, scope: 'pod', subject: 'tenant-a-1' }).groupBy).toBe('pod');
    expect(buildTrafficQuery({ ...base, scope: 'pod', subject: 'tenant-a-1', pod: 'web-1' }).groupBy).toBe('pod');
  });
});

describe('backup classes are not confined to a namespace allowlist', () => {
  it('finds a database backup wherever its uploader runs', () => {
    // CNPG's barman-cloud lives in `cnpg-system`; an allowlist of
    // tenant-*/platform/mail hid every byte of it.
    const expr = buildTrafficQuery({ ...base, scope: 'backup-class', backupClass: 'databases' }).expr;
    expect(expr).toContain('pod=~"barman-.+"');
    expect(expr).not.toContain('namespace=~');
  });

  it('still identifies each class by its own pod prefix', () => {
    for (const [cls, re] of Object.entries(BACKUP_CLASS_POD_RE)) {
      const expr = buildTrafficQuery({
        ...base, scope: 'backup-class', backupClass: cls as keyof typeof BACKUP_CLASS_POD_RE,
      }).expr;
      expect(expr, cls).toContain(`pod=~"${re}"`);
    }
  });
});
