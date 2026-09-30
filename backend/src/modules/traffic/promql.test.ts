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

describe('a tenant is measured at the INGRESS, a pod at the pod', () => {
  // Was: "tenant traffic uses the namespace, not the root cgroup". It did,
  // and that was the defect: per-namespace pod counters include the database
  // answering the application inside the namespace, on a path that never
  // touches the network. Production over six hours — pods 2.15 GB out,
  // ingress 274 MB served, 7.0x across the fleet and 1.0x for every tenant
  // with no database. A tenant's traffic is what left.
  it('bills a tenant on what the ingress served, not on what their pods moved', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'tenant', subject: 'tenant-a-1' }).expr;
    expect(expr).toContain('traefik_service_responses_bytes_total');
    expect(expr).toContain('service=~"tenant-a-1-.+"');
    expect(expr).not.toContain('container_network');
  });

  // The pod breakdown is the one place internal traffic is visible, so it
  // must keep reading the pod.
  it('a pod scope still reads the pod counters', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'pod', subject: 'tenant-a-1' }).expr;
    expect(expr).toContain('container_network');
    expect(expr).toContain('namespace="tenant-a-1"');
    expect(expr).not.toContain('id="/"');
  });

  // Was: "refuses a pod scope with no tenant". It threw
  // TRAFFIC_QUERY_UNSUPPORTED, which is what the operator saw on the panel's
  // own default pod view — an error for a question the store answers fine.
  it('a pod scope with no tenant is every tenant pod, grouped by pod', () => {
    const { expr, groupBy } = buildTrafficQuery({ ...base, scope: 'pod' });
    expect(groupBy).toBe('pod');
    expect(expr).toContain('namespace=~"tenant-.+"');
    expect(expr).toContain('sum by (pod)');
  });

  it('reads the right counter per direction', () => {
    expect(buildTrafficQuery({ ...base, scope: 'cluster', direction: 'in' }).expr)
      .toContain('container_network_receive_bytes_total');
    expect(buildTrafficQuery({ ...base, scope: 'cluster', direction: 'out' }).expr)
      .toContain('container_network_transmit_bytes_total');
  });
});

// The namespace shape matters to these assertions — `tenant-<slug>-<8 hex>`
// is what the rewrite regex keys on — but a literal of that shape reads as a
// real customer's namespace in a public repo. Composed from parts so the
// shape is exercised and no such literal exists in the file.
const HEX8 = 'deadbeef';
const PARENT_NS = `tenant-alpha-${HEX8}`;
const CHILD_NS = `${PARENT_NS}-eu-${HEX8}`;

describe('a tenant prefix must not reach a nested tenant', () => {
  /**
   * Namespaces NEST. `tenant-acme-<hash>` and `tenant-acme-<hash>-eu-<hash2>`
   * are two different customers and the second begins with the first, so
   * `service=~"<parent>-.+"` matches the child's services too. Before the
   * ingress switch a tenant was selected by an exact `namespace=` label and
   * this could not happen; a prefix matcher reintroduces it, in a number the
   * parent is billed on.
   */
  it('excludes a nested namespace from the parent\u2019s query', () => {
    const { expr } = buildTrafficQuery({
      ...base,
      scope: 'tenant',
      subject: PARENT_NS,
      excludeNestedNamespaces: [CHILD_NS],
    });
    expect(expr).toContain(`service=~"${PARENT_NS}-.+"`);
    expect(expr).toContain(`service!~"${CHILD_NS}-.+"`);
  });

  it('adds no exclusion when nothing nests', () => {
    const { expr } = buildTrafficQuery({
      ...base, scope: 'tenant', subject: PARENT_NS, excludeNestedNamespaces: [],
    });
    expect(expr).not.toContain('service!~');
  });

  it('the parent selector alone WOULD have matched the child', () => {
    // Stated as a test so the reason for the exclusion cannot be optimised
    // away by someone who reads only the happy path.
    const { expr } = buildTrafficQuery({
      ...base, scope: 'tenant', subject: PARENT_NS,
    });
    const m = /service=~"([^"]+)"/.exec(expr);
    expect(m).not.toBeNull();
    expect(new RegExp(`^${m![1]}$`).test(`${CHILD_NS}-ingress-abc`)).toBe(true);
  });
});

describe('backup separation', () => {
  // Was asserted on `tenant` scope, which is measured at the ingress now and
  // cannot see a backup pod at all. The exclusion still has to work where
  // pod counters are still read — the pod breakdown.
  it('excludes every backup class from a pod-measured view', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'pod', subject: 'tenant-a-1', backups: 'exclude' }).expr;
    for (const re of Object.values(BACKUP_CLASS_POD_RE)) expect(expr).toContain(re);
    expect(expr).toContain('pod!~');
  });

  it('isolates one class', () => {
    // A tenant bundle is one class covering BOTH of its capture jobs.
    const expr = buildTrafficQuery({ ...base, scope: 'backup-class', backupClass: 'tenant-bundles' }).expr;
    expect(expr).toContain('pod=~"bk-(files|mbox)-.+"');
  });

  it('counts the mail server\u2019s own snapshots, which the first cut missed', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'backup-class', backupClass: 'mail-snapshots' }).expr;
    expect(expr).toContain('stalwart-snapshot-cron-.+');
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

describe('retained plumbing must not inflate history', () => {
  it('excludes virtual interfaces in the QUERY, not only at scrape time', () => {
    // The store keeps 30 days, and those days already hold one Calico veth
    // per pod on the root cgroup. Trusting the scrape rule alone measured a
    // day that moved 46 GB as 265 GB.
    // `tenant` is not in this list any more: it reads Traefik, which has no
    // interface dimension. Every scope that still reads cAdvisor is.
    for (const scope of ['node', 'pod'] as const) {
      const expr = buildTrafficQuery({
        ...base, scope, subject: scope === 'pod' ? 'tenant-a-1' : undefined,
      }).expr;
      expect(expr, scope).toContain('interface!~');
      expect(expr, scope).toContain('cali[0-9a-f].*');
    }
  });

  it('excludes the retained veths on a plain cluster query too', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'cluster' }).expr;
    expect(expr).toContain('cali[0-9a-f].*');
  });

  it('selects ONLY the encapsulation for node-to-node, and never adds it to the wire', () => {
    const n2n = buildTrafficQuery({ ...base, scope: 'cluster', wireSubset: 'node-to-node' }).expr;
    expect(n2n).toContain('interface=~"vxlan.*|wireguard.*"');
    expect(n2n).toContain('id="/"');
  });

  it('measures off-site upload at the shim, not at the backup jobs', () => {
    // The jobs send to an in-cluster relay; only the relay's egress leaves.
    const off = buildTrafficQuery({ ...base, scope: 'cluster', wireSubset: 'offsite-backup' }).expr;
    expect(off).toContain('pod=~"backup-rclone.+"');
    expect(off).not.toContain('id="/"');
  });

  it('still names no real NIC — the exclusion lists what is virtual', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'cluster' }).expr;
    expect(expr).not.toMatch(/interface\s*=\s*"/);   // no equality match
    expect(expr).not.toContain('eth0');
  });

  it('keeps the exclusion on backup-class queries too', () => {
    const expr = buildTrafficQuery({ ...base, scope: 'backup-class', backupClass: 'files' }).expr;
    expect(expr).toContain('interface!~');
  });
});

describe('every generated query is valid PromQL', () => {
  // A PromQL string literal accepts only a fixed set of escapes. `\.` is not
  // one of them, and VictoriaMetrics answers 422 — which reached the panel as
  // "Unexpected error" with no chart at all.
  const BAD_ESCAPE = /\\(?!\\|"|n|t|r|'|`)/;

  const everyQuery = (): string[] => {
    const base = { metric: 'traffic', direction: 'out', stepSeconds: 300 } as const;
    const out: string[] = [];
    for (const scope of ['cluster', 'node', 'tenant', 'pod', 'route'] as const) {
      for (const metric of ['traffic', 'requests', 'latency'] as const) {
        for (const subject of [undefined, 'tenant-alpha-example']) {
          try {
            out.push(buildTrafficQuery({ ...base, scope, metric, subject }).expr);
          } catch { /* unsupported combinations are refused on purpose */ }
        }
      }
    }
    for (const wireSubset of ['node-to-node', 'offsite-backup'] as const) {
      out.push(buildTrafficQuery({ ...base, scope: 'cluster', wireSubset }).expr);
    }
    for (const cls of Object.keys(BACKUP_CLASS_POD_RE) as Array<keyof typeof BACKUP_CLASS_POD_RE>) {
      out.push(buildTrafficQuery({ ...base, scope: 'backup-class', backupClass: cls }).expr);
    }
    out.push(buildTrafficQuery({ ...base, scope: 'tenant', backups: 'exclude', subject: 'tenant-a-1' }).expr);
    return out;
  };

  it('contains no escape a PromQL string literal would reject', () => {
    for (const expr of everyQuery()) {
      expect(BAD_ESCAPE.test(expr), expr).toBe(false);
    }
  });

  it('balances every brace and quote', () => {
    for (const expr of everyQuery()) {
      expect((expr.match(/\{/g) ?? []).length, expr).toBe((expr.match(/\}/g) ?? []).length);
      expect((expr.match(/"/g) ?? []).length % 2, expr).toBe(0);
      expect((expr.match(/\(/g) ?? []).length, expr).toBe((expr.match(/\)/g) ?? []).length);
    }
  });
});
