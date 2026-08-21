import { describe, it, expect } from 'vitest';
import { selectStalePodTargets, countStalePodsByNode } from './recovery.js';

/** Minimal pod shape matching what the k8s client returns. */
function pod(opts: {
  ns: string;
  name: string;
  node?: string;
  phase?: string;
  reason?: string;
  unknown?: boolean;
  labels?: Record<string, string>;
}) {
  return {
    metadata: { namespace: opts.ns, name: opts.name, labels: opts.labels ?? {} },
    spec: { nodeName: opts.node ?? 'sv1' },
    status: {
      phase: opts.phase ?? 'Running',
      reason: opts.reason,
      containerStatuses: opts.unknown ? [{ state: { unknown: {} } }] : [],
    },
  };
}

describe('selectStalePodTargets', () => {
  it('selects Failed, Evicted and Unknown-state pods', () => {
    const out = selectStalePodTargets([
      pod({ ns: 'platform', name: 'failed-1', phase: 'Failed' }),
      pod({ ns: 'platform', name: 'evicted-1', reason: 'Evicted' }),
      pod({ ns: 'platform', name: 'unknown-1', unknown: true }),
      pod({ ns: 'platform', name: 'running-1' }),
    ]);
    expect(out.map((t) => t.name).sort()).toEqual(['evicted-1', 'failed-1', 'unknown-1']);
  });

  it('REFUSES tenant namespaces even when Failed', () => {
    const out = selectStalePodTargets([
      pod({ ns: 'tenant-acme', name: 'failed-tenant', phase: 'Failed' }),
    ]);
    expect(out).toEqual([]);
  });

  it('refuses namespaces outside the safe list', () => {
    const out = selectStalePodTargets([
      pod({ ns: 'some-random-ns', name: 'failed-x', phase: 'Failed' }),
    ]);
    expect(out).toEqual([]);
  });

  it('REFUSES a CNPG instance pod in `platform` even when Failed', () => {
    // `platform` is a safe namespace AND hosts the CNPG system-db, so this
    // guard is the only thing between the action and a Postgres pod.
    //
    // The label set below is copied VERBATIM from a live cluster
    // (`kubectl -n platform get pod system-db-1 -o jsonpath='{.metadata.labels}'`).
    // The previous fixture invented `cnpg.io/instance`, which nothing sets —
    // so it asserted the code against its own wrong assumption and passed
    // while the real pod was unprotected.
    const realCnpgLabels = {
      'app.kubernetes.io/managed-by': 'cloudnative-pg',
      'cnpg.io/cluster': 'system-db',
      'cnpg.io/instanceName': 'system-db-1',
      'cnpg.io/instanceRole': 'primary',
      'cnpg.io/podRole': 'instance',
      role: 'primary',
    };
    const out = selectStalePodTargets([
      pod({ ns: 'platform', name: 'system-db-1', phase: 'Failed', labels: realCnpgLabels }),
      pod({ ns: 'platform', name: 'version-poller-x', phase: 'Failed' }),
    ]);
    expect(out.map((t) => t.name)).toEqual(['version-poller-x']);
  });

  it('refuses on EACH CNPG signal independently', () => {
    // Upstream label sets change. Any one of these means "CNPG instance".
    for (const labels of [
      { 'cnpg.io/podRole': 'instance' },
      { 'cnpg.io/instanceName': 'system-db-1' },
      { 'cnpg.io/instanceRole': 'replica' },
      { 'cnpg.io/cluster': 'system-db' },
    ]) {
      const out = selectStalePodTargets([
        pod({ ns: 'platform', name: 'db-x', phase: 'Failed', labels }),
      ]);
      expect(out, `should refuse ${JSON.stringify(labels)}`).toEqual([]);
    }
  });

  it('carries the node so counts can be grouped', () => {
    const out = selectStalePodTargets([
      pod({ ns: 'platform', name: 'f1', phase: 'Failed', node: 'sv2' }),
    ]);
    expect(out[0]?.node).toBe('sv2');
  });
});

describe('countStalePodsByNode', () => {
  const fakeK8s = (items: unknown[]) =>
    ({ core: { listPodForAllNamespaces: async () => ({ items }) } }) as never;

  it('groups by node and counts only what the cleanup would delete', async () => {
    // The count and the delete MUST agree: a modal offering to clean 3 pods
    // that then removes 0 is worse than not offering the action at all.
    const items = [
      pod({ ns: 'platform', name: 'f1', phase: 'Failed', node: 'sv1' }),
      pod({ ns: 'platform', name: 'f2', reason: 'Evicted', node: 'sv1' }),
      pod({ ns: 'platform', name: 'ok', node: 'sv1' }),
      pod({ ns: 'tenant-acme', name: 'tf', phase: 'Failed', node: 'sv1' }),
      pod({ ns: 'platform', name: 'f3', phase: 'Failed', node: 'sv2' }),
    ];
    const counts = await countStalePodsByNode(fakeK8s(items));
    expect(counts).toEqual({ sv1: 2, sv2: 1 });

    // Same predicate, same answer.
    const selected = selectStalePodTargets(items).filter((t) => t.node === 'sv1');
    expect(selected.length).toBe(counts.sv1);
  });

  it('returns an empty map when nothing is stale — not an error', async () => {
    const counts = await countStalePodsByNode(fakeK8s([pod({ ns: 'platform', name: 'ok' })]));
    expect(counts).toEqual({});
  });

  it('skips pods with no node assigned', async () => {
    const counts = await countStalePodsByNode(
      fakeK8s([pod({ ns: 'platform', name: 'f', phase: 'Failed', node: '' })]),
    );
    expect(counts).toEqual({});
  });
});
