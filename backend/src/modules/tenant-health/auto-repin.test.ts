/**
 * Auto re-pin safety gates.
 *
 * Every `continue` in selectAutoRepinCandidates prevents a specific way of
 * making an outage worse. These tests exist so a future refactor cannot
 * quietly drop one — the dangerous failure here is a FALSE POSITIVE
 * (unpinning a tenant whose data really is only on the dead node), so most
 * cases assert that we do NOT act.
 */
import { describe, it, expect } from 'vitest';
import { selectAutoRepinCandidates, autoRepinDisabled } from './auto-repin.js';
import type { NodeFact, ReplicaFact, TenantFact, VolumeFact } from './service.js';

const nodes: NodeFact[] = [
  { name: 'live-a', ready: true, role: 'server', notReadySince: null },
  { name: 'live-b', ready: true, role: 'server', notReadySince: null },
  { name: 'dead-c', ready: false, role: 'server', notReadySince: '2026-09-11T15:00:00Z' },
];

const tenant = (over: Partial<TenantFact> = {}): TenantFact => ({
  id: 't1', name: 'Acme', namespace: 'tenant-acme',
  storageTier: 'ha', pinnedNode: 'dead-c', status: 'active', hasMailboxes: false,
  ...over,
});

const vol = (name: string, ns = 'tenant-acme'): VolumeFact =>
  ({ volumeName: name, namespace: ns, pvcName: 'data', robustness: 'degraded' });

const rep = (volumeName: string, nodeId: string): ReplicaFact => ({ volumeName, nodeId });

const run = (over: {
  tenants?: TenantFact[]; volumes?: VolumeFact[]; replicas?: ReplicaFact[]; nodes?: NodeFact[];
} = {}) => selectAutoRepinCandidates({
  nodes: over.nodes ?? nodes,
  tenants: over.tenants ?? [tenant()],
  volumes: over.volumes ?? [vol('pvc-1')],
  replicas: over.replicas ?? [rep('pvc-1', 'live-a'), rep('pvc-1', 'dead-c')],
});

describe('selectAutoRepinCandidates', () => {
  it('re-pins an HA-tier tenant stranded on a dead node', () => {
    const out = run();
    expect(out).toHaveLength(1);
    expect(out[0].tenantId).toBe('t1');
    expect(out[0].strandedOn).toBe('dead-c');
    expect(out[0].liveReplicaNodes).toEqual(['live-a']);
  });

  it('NEVER touches a local-tier tenant — its only replica is on the dead node', () => {
    const out = run({
      tenants: [tenant({ storageTier: 'local' })],
      replicas: [rep('pvc-1', 'dead-c')],
    });
    expect(out).toEqual([]);
  });

  it('refuses when EVERY replica is on a downed node, even on the HA tier', () => {
    // Tier says "ha" but the second replica has not been built yet — moving
    // this tenant would strand it exactly like a local-tier one.
    const out = run({ replicas: [rep('pvc-1', 'dead-c')] });
    expect(out).toEqual([]);
  });

  it('refuses when one of several volumes has no live replica', () => {
    const out = run({
      volumes: [vol('pvc-1'), vol('pvc-2')],
      replicas: [rep('pvc-1', 'live-a'), rep('pvc-2', 'dead-c')],
    });
    expect(out).toEqual([]);
  });

  it('ignores a tenant pinned to a node that is still Ready', () => {
    expect(run({ tenants: [tenant({ pinnedNode: 'live-a' })] })).toEqual([]);
  });

  it('ignores an unpinned tenant — there is nothing to clear', () => {
    expect(run({ tenants: [tenant({ pinnedNode: null })] })).toEqual([]);
  });

  it.each(['suspended', 'archived', 'deleted', 'deleting', 'pending'])(
    'does not resurrect a %s tenant',
    (status) => {
      expect(run({ tenants: [tenant({ status })] })).toEqual([]);
    },
  );

  it('does nothing when no node is down', () => {
    const allReady = nodes.map((n) => ({ ...n, ready: true }));
    expect(run({ nodes: allReady })).toEqual([]);
  });

  it('does nothing when there is nowhere Ready to move to', () => {
    const allDead = nodes.map((n) => ({ ...n, ready: false }));
    expect(run({ nodes: allDead })).toEqual([]);
  });

  it('allows a volume-less tenant — pure compute can move freely', () => {
    const out = run({ volumes: [], replicas: [] });
    expect(out).toHaveLength(1);
    expect(out[0].liveReplicaNodes).toEqual([]);
  });

  it('only considers volumes in the tenant own namespace', () => {
    // A stranded volume belonging to SOMEONE ELSE must not block this tenant.
    const out = run({
      volumes: [vol('pvc-1'), vol('pvc-other', 'tenant-other')],
      replicas: [rep('pvc-1', 'live-a'), rep('pvc-other', 'dead-c')],
    });
    expect(out).toHaveLength(1);
  });
});

describe('kill switch', () => {
  it('is off by default', () => {
    expect(autoRepinDisabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
  it('disables on the documented value only', () => {
    expect(autoRepinDisabled({ AUTO_REPIN_HA_TENANTS: 'disable' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(autoRepinDisabled({ AUTO_REPIN_HA_TENANTS: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});
