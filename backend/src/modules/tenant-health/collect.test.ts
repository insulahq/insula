/**
 * The outage collector must degrade, not disappear.
 *
 * A node loss is the one moment this endpoint exists for — and it is also the
 * moment the platform Postgres may be mid-failover, because the dead node could
 * have been carrying the primary. Measured on staging 2026-09-11: the DB was
 * unavailable for ~90 s after `staging1` went NotReady.
 *
 * Node readiness comes from Kubernetes and survives that. Tenant impact comes
 * from the DB and does not. The contract is: still name the down node, and set
 * `readError` so the UI shows "unknown" rather than a reassuring zero.
 */
import { describe, it, expect } from 'vitest';
import { collectFacts } from './collect.js';
import { computeOutageImpact } from './service.js';

type Any = Record<string, unknown>;

/** Fixed, because the route — not the collector — stamps the observation time. */
const OBSERVED_AT = new Date('2026-09-11T20:35:00Z');

const NODES = {
  items: [
    { metadata: { name: 'n1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
    {
      metadata: { name: 'n2' },
      status: {
        conditions: [
          { type: 'Ready', status: 'Unknown', lastTransitionTime: '2026-09-11T20:30:00Z' },
        ],
      },
    },
  ],
};

const okK8s = () => ({
  core: {
    listNode: async () => NODES,
    listPodForAllNamespaces: async () => ({ items: [] }),
  },
  custom: { listNamespacedCustomObject: async () => ({ items: [] }) },
  // A watched platform service with one ready endpoint — the healthy case, so
  // the DB-outage assertions below are about the DB and nothing else.
  disco: {
    listNamespacedEndpointSlice: async () => ({
      items: [{ endpoints: [{ conditions: { ready: true } }] }],
    }),
  },
}) as unknown as Parameters<typeof collectFacts>[1];

/** A db whose every query rejects, the way pg does when the primary is gone. */
const deadDb = () => {
  const boom = () => { throw new Error('terminating connection due to administrator command'); };
  const chain: Any = {};
  for (const m of ['select', 'from', 'groupBy', 'where']) chain[m] = () => chain;
  chain.then = (_res: unknown, rej: (e: unknown) => void) => { try { boom(); } catch (e) { rej(e); } };
  return { select: () => chain } as unknown as Parameters<typeof collectFacts>[0];
};

const liveDb = () => {
  const rows = [
    [{ id: 't1', name: 'acme', ns: 'tenant-acme', tier: 'local', pin: 'n2', status: 'active' }],
    [],
    [{ activeNode: 'n1' }],
  ];
  let i = 0;
  const mk = (): Any => {
    const r = rows[i++] ?? [];
    const c: Any = {};
    for (const m of ['from', 'groupBy', 'where']) c[m] = () => c;
    c.then = (res: (v: unknown) => void) => res(r);
    return c;
  };
  return { select: () => mk() } as unknown as Parameters<typeof collectFacts>[0];
};

describe('collectFacts under a database outage', () => {
  it('still reports the down node when every DB read fails', async () => {
    const facts = await collectFacts(deadDb(), okK8s());
    expect(facts.nodes.filter((n) => !n.ready).map((n) => n.name)).toEqual(['n2']);
  });

  it('records a readError instead of silently returning zero tenants', async () => {
    const facts = await collectFacts(deadDb(), okK8s());
    expect(facts.tenants).toEqual([]);
    expect(facts.readError).toBeTruthy();
    expect(facts.readError).toContain('tenants');
  });

  it('surfaces the outage to the operator as unknown, never as healthy', async () => {
    const facts = await collectFacts(deadDb(), okK8s());
    const impact = computeOutageImpact({ ...facts, observedAt: OBSERVED_AT });
    expect(impact.nodesDown.map((n) => n.name)).toEqual(['n2']);
    expect(impact.readError).toBeTruthy();
  });

  it('reports real tenant impact once the DB answers again', async () => {
    const facts = await collectFacts(liveDb(), okK8s());
    expect(facts.readError).toBeFalsy();
    const impact = computeOutageImpact({ ...facts, observedAt: OBSERVED_AT });
    expect(impact.nodesDown.map((n) => n.name)).toEqual(['n2']);
    expect(impact.affectedTenants.map((t) => t.tenantName)).toEqual(['acme']);
  });
});
