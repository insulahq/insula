import { describe, it, expect } from 'vitest';
import {
  buildTrafficQuery, quoteLabel, serviceMatcherForNamespace, UnsupportedTrafficQuery,
  BACKUP_CLASS_POD_RE,
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

  it('escapes regex metacharacters in a namespace service matcher', () => {
    expect(serviceMatcherForNamespace('tenant-a.b+c')).toBe('tenant-a\\.b\\+c-.+');
  });
});
