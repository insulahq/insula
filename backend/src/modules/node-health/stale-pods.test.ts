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
  owned?: boolean;
}) {
  return {
    metadata: {
      namespace: opts.ns, name: opts.name, labels: opts.labels ?? {},
      ownerReferences: (opts.owned ?? true) ? [{ controller: true }] : [],
    },
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

// ── node-shutdown debris, allowed in ANY namespace (2026-09-11) ──
//
// Production carried 17 reboot casualties across four reboots; five could not
// be cleared from the UI at all — four in `tenant-*` and one in `mail`, which
// is simply not on SAFE_NAMESPACES. Every fixture below is the real shape the
// kubelet leaves.
describe('selectStalePodTargets — node-shutdown debris', () => {
  it('selects a drained pod in a TENANT namespace', () => {
    const out = selectStalePodTargets([
      pod({ ns: 'tenant-acme-1234', name: 'app-579c57db7b-6xjnz', phase: 'Failed', reason: 'Terminated' }),
    ]);
    expect(out).toEqual([{ ns: 'tenant-acme-1234', name: 'app-579c57db7b-6xjnz', node: 'sv1' }]);
  });

  it('selects a drained pod in a namespace absent from SAFE_NAMESPACES', () => {
    // `mail` is not on the list, which is why bulwark was stuck.
    const out = selectStalePodTargets([
      pod({ ns: 'mail', name: 'bulwark-5d5f76db7b-vh5cb', phase: 'Failed', reason: 'Terminated' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('selects a pod REJECTED by a shutting-down node', () => {
    const out = selectStalePodTargets([
      pod({ ns: 'tigera-operator', name: 'tigera-operator-x', phase: 'Failed', reason: 'NodeShutdown' }),
    ]);
    expect(out).toHaveLength(1);
  });

  // ── what the wider arm must still refuse ──

  it('refuses a BARE shutdown casualty — nothing would replace it', () => {
    const out = selectStalePodTargets([
      pod({ ns: 'tenant-acme-1234', name: 'bare-pod', phase: 'Failed', reason: 'Terminated', owned: false }),
    ]);
    expect(out).toEqual([]);
  });

  it('refuses a CNPG instance pod even when stamped by a node shutdown', () => {
    const out = selectStalePodTargets([
      pod({
        ns: 'platform', name: 'system-db-1', phase: 'Failed', reason: 'Terminated',
        labels: { 'cnpg.io/instanceName': 'system-db-1' },
      }),
    ]);
    expect(out).toEqual([]);
  });

  it('refuses a RUNNING pod carrying a shutdown reason', () => {
    const out = selectStalePodTargets([
      pod({ ns: 'mail', name: 'still-up', phase: 'Running', reason: 'Terminated' }),
    ]);
    expect(out).toEqual([]);
  });

  // ── the narrow arm must stay narrow ──

  it('still refuses a plain Failed pod in a TENANT namespace', () => {
    // Not kubelet-attributed reboot debris — a crashed tenant workload. The
    // widening must not become a blanket tenant-pod delete.
    const out = selectStalePodTargets([
      pod({ ns: 'tenant-acme-1234', name: 'crashed', phase: 'Failed' }),
    ]);
    expect(out).toEqual([]);
  });

  it('still refuses a plain Failed pod in a non-SAFE namespace', () => {
    const out = selectStalePodTargets([
      pod({ ns: 'mail', name: 'crashed', phase: 'Failed' }),
    ]);
    expect(out).toEqual([]);
  });

  it('still refuses an Evicted tenant pod', () => {
    const out = selectStalePodTargets([
      pod({ ns: 'tenant-acme-1234', name: 'evicted', reason: 'Evicted' }),
    ]);
    expect(out).toEqual([]);
  });

  it('counts the production mix correctly: 17 debris across 8 namespaces', () => {
    const mix = [
      ...Array.from({ length: 3 }, (_, i) => pod({ ns: 'calico-system', name: `c${i}`, phase: 'Failed', reason: 'Terminated' })),
      ...Array.from({ length: 2 }, (_, i) => pod({ ns: 'kube-system', name: `k${i}`, phase: 'Failed', reason: 'Terminated' })),
      ...Array.from({ length: 5 }, (_, i) => pod({ ns: 'longhorn-system', name: `l${i}`, phase: 'Failed', reason: 'Terminated' })),
      ...Array.from({ length: 2 }, (_, i) => pod({ ns: 'traefik', name: `t${i}`, phase: 'Failed', reason: 'Terminated' })),
      pod({ ns: 'mail', name: 'bulwark', phase: 'Failed', reason: 'Terminated' }),
      pod({ ns: 'tenant-a-1', name: 'perfex', phase: 'Failed', reason: 'Terminated' }),
      pod({ ns: 'tenant-b-2', name: 'fpl-app', phase: 'Failed', reason: 'Terminated' }),
      ...Array.from({ length: 2 }, (_, i) => pod({ ns: 'tenant-c-3', name: `p${i}`, phase: 'Failed', reason: 'Terminated' })),
    ];
    const out = selectStalePodTargets(mix);
    expect(out).toHaveLength(17);
    // All five previously-unclearable ones are now included, by name.
    const names = out.map((t) => `${t.ns}/${t.name}`);
    expect(names).toContain('mail/bulwark');
    expect(names).toContain('tenant-a-1/perfex');
    expect(names).toContain('tenant-b-2/fpl-app');
    expect(names.filter((n) => n.startsWith('tenant-c-3/'))).toHaveLength(2);
  });
});
