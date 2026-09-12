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

/**
 * Recovering node identity from the platform's own inventory.
 *
 * The 2026-09-12 quorum-loss drill left the platform able to report that
 * something was wrong but not WHICH machine — the node list is itself an
 * API-server read, so losing the control plane lost the names with it. The
 * database survives that (it served operator logins throughout the drill) and
 * the node-sync reconciler already persists conditions to `cluster_nodes`, so
 * the names are recoverable — stale by a minute or two, and labelled as such.
 */
describe('node list fallback to the persisted inventory', () => {
  const k8sWithDeadNodeRead = () => ({
    core: {
      listNode: async () => { throw new Error('apiserver not ready'); },
      listPodForAllNamespaces: async () => ({ items: [] }),
    },
    custom: { listNamespacedCustomObject: async () => ({ items: [] }) },
    disco: { listNamespacedEndpointSlice: async () => ({ items: [] }) },
  }) as unknown as Parameters<typeof collectFacts>[1];

  /** A db whose cluster_nodes query returns rows; everything else is empty. */
  const dbWithInventory = (rows: unknown[]) => {
    let call = 0;
    const mk = (): Any => {
      const idx = call++;
      const c: Any = {};
      for (const m of ['from', 'groupBy', 'where']) c[m] = () => c;
      // 0 tenants, 1 mailbox counts, 2 settings, 3 cluster_nodes
      c.then = (res: (v: unknown) => void) => res(idx === 3 ? rows : []);
      return c;
    };
    return { select: () => mk() } as unknown as Parameters<typeof collectFacts>[0];
  };

  const row = (name: string, ready: string, seen: string) => ({
    name, role: 'server', ingressMode: 'all',
    publicIp: '198.51.100.1', publicIpv6: null,
    statusConditions: [{ type: 'Ready', status: ready }],
    lastSeenAt: new Date(seen),
  });

  it('uses the inventory when the live node read fails, and reports how stale it is', async () => {
    const facts = await collectFacts(
      dbWithInventory([
        row('staging1', 'True', '2026-09-12T10:45:30Z'),
        row('staging3', 'Unknown', '2026-09-12T10:45:00Z'),
      ]),
      k8sWithDeadNodeRead(),
    );
    expect(facts.nodes.map((n) => n.name).sort()).toEqual(['staging1', 'staging3']);
    expect(facts.nodes.find((n) => n.name === 'staging3')?.ready).toBe(false);
    // Oldest observation, so the caveat is not more flattering than the data.
    expect(facts.nodesAsOf).toBe('2026-09-12T10:45:00.000Z');
    // The live read still failed, and that must not be hidden by the recovery.
    expect(facts.readError).toContain('nodes');
  });

  it('does NOT substitute inventory for a live read that legitimately returned no nodes', async () => {
    // A successful read of an empty cluster is a different fact from a failed
    // read, and quietly replacing it with stale rows would invent nodes.
    const k8s = {
      core: {
        listNode: async () => ({ items: [] }),
        listPodForAllNamespaces: async () => ({ items: [] }),
      },
      custom: { listNamespacedCustomObject: async () => ({ items: [] }) },
      disco: { listNamespacedEndpointSlice: async () => ({ items: [] }) },
    } as unknown as Parameters<typeof collectFacts>[1];
    const facts = await collectFacts(dbWithInventory([row('staging1', 'True', '2026-09-12T10:45:00Z')]), k8s);
    expect(facts.nodes).toEqual([]);
    expect(facts.nodesAsOf).toBeNull();
  });

  it('claims nothing when the inventory is also empty', async () => {
    const facts = await collectFacts(dbWithInventory([]), k8sWithDeadNodeRead());
    expect(facts.nodes).toEqual([]);
    expect(facts.nodesAsOf).toBeNull();
    expect(facts.readError).toBeTruthy();
  });
});
