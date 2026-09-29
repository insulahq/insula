/**
 * A subject key has one job: hand it back as `subject` and get that subject.
 *
 * It did not. On a breakdown every series key is prefixed with its direction
 * so that "out" and "in" for one subject are separate rows, and the picker
 * returned those row ids verbatim. Selecting a node built `node="out:sv1"`;
 * selecting a tenant built `namespace="out:tenant-<slug>-<hash>"`. Both match
 * nothing, so the individual node, tenant, pod and route views all read "no
 * traffic" while the breakdown they were chosen from was full of it — and
 * the pod picker, which is fed by the tenant key, came back empty.
 *
 * Nothing caught it because every test asserted a frame in isolation. The
 * property that matters is the ROUND TRIP between the two calls, so that is
 * what these assert.
 */
import { describe, it, expect, vi } from 'vitest';

const LABELLED: Record<string, string> = {
  node: 'sv1',
  namespace: 'tenant-acme-1a2b3c4d',
  pod: 'website-794d87b45d-pljpd',
  service: 'tenant-acme-1a2b3c4d-tenant-acme-1a2b3c4d-ingress-66364415ff27@kubernetescrd',
};

vi.mock('../monitoring/vm-client.js', () => ({
  // Echo back whichever label the query grouped by, the way the store does.
  queryRange: (expr: string) => {
    const by = /sum by \(([a-z]+)\)/.exec(expr)?.[1];
    const now = Math.floor(Date.now() / 1000);
    const labels = by && LABELLED[by] ? { [by]: LABELLED[by] } : {};
    return Promise.resolve([{ labels, points: [[now - 600, 5], [now - 300, 7]] }]);
  },
  queryInstant: () => Promise.resolve([]),
}));

const { fetchTrafficSubjects, subjectIdOf } = await import('./service.js');
const { buildTrafficQuery } = await import('./promql.js');

const db = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([]), then: (r: (v: unknown) => void) => r([]) }) }),
} as never;
const range = { from: new Date(Date.now() - 3_600_000), to: new Date() };

describe('a subject key round-trips into a query', () => {
  const cases = [
    { scope: 'node' as const, label: 'node', expect: 'node="sv1"' },
    { scope: 'tenant' as const, label: 'namespace', expect: 'namespace="tenant-acme-1a2b3c4d"' },
  ];

  for (const c of cases) {
    it(`${c.scope}: the key the picker offers selects that ${c.scope}`, async () => {
      const subjects = await fetchTrafficSubjects(
        { ...range, scope: c.scope, metric: 'traffic' } as never, { db },
      );
      expect(subjects.length, 'the picker offered nothing to choose').toBeGreaterThan(0);

      const key = subjects[0].key;
      // The bug, stated directly: a direction prefix is not part of an identity.
      expect(key, `subject key carries a direction prefix: ${key}`).not.toMatch(/^(in|out):/);

      // And the round trip — this is the assertion that would have caught it.
      const { expr } = buildTrafficQuery({
        scope: c.scope, metric: 'traffic', direction: 'out', stepSeconds: 300, subject: key,
      });
      expect(expr).toContain(c.expect);
    });
  }

  it('a tenant key is usable as the namespace a pod list hangs off', async () => {
    const tenants = await fetchTrafficSubjects(
      { ...range, scope: 'tenant', metric: 'traffic' } as never, { db },
    );
    const pods = await fetchTrafficSubjects(
      { ...range, scope: 'pod', metric: 'traffic', subject: tenants[0].key } as never, { db },
    );
    expect(pods.map((p) => p.key)).toEqual(['website-794d87b45d-pljpd']);
  });

  it('strips only the direction prefix, never part of a name', () => {
    expect(subjectIdOf('out:sv1')).toBe('sv1');
    expect(subjectIdOf('in:tenant-a-1a2b3c4d')).toBe('tenant-a-1a2b3c4d');
    // A subject legitimately containing the substring must survive intact.
    expect(subjectIdOf('outbound-gw')).toBe('outbound-gw');
    expect(subjectIdOf('internal:thing')).toBe('internal:thing');
  });
});
