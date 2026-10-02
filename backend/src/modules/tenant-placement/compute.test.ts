import { describe, expect, it } from 'vitest';
import { computePlacements, observeStorageFailovers, observeTenantPlacement } from './compute.js';
import type { PodFact, ReplicaFact, TenantFact, VolumeFact } from '../tenant-health/service.js';

const NS = 'tenant-acme';
const tenant = (over: Partial<TenantFact> = {}): TenantFact => ({
  id: 't1', name: 'Acme', namespace: NS, storageTier: 'local', pinnedNode: 'node-a',
  status: 'active', hasMailboxes: false, ...over,
});
const pod = (nodeName: string, over: Partial<PodFact> = {}): PodFact => ({
  namespace: NS, name: `web-${nodeName}`, nodeName, ready: true, phase: 'Running',
  createdAt: null, controllerKind: 'ReplicaSet', ...over,
});
const vol = (over: Partial<VolumeFact> = {}): VolumeFact => ({
  volumeName: 'pvc-1', namespace: NS, pvcName: `${NS}-storage`, robustness: 'healthy',
  attached: true, pvcRefLostAt: null, attachedNode: 'node-a', remountRequestedAt: null, ...over,
});
const rep = (nodeId: string, over: Partial<ReplicaFact> = {}): ReplicaFact => ({
  volumeName: 'pvc-1', nodeId, running: true, failed: false, ...over,
});

describe('observeTenantPlacement — local tier', () => {
  it('is placed when workloads, attachment and data are all on the primary node', () => {
    const p = observeTenantPlacement(tenant(), { pods: [pod('node-a')], volumes: [vol()], replicas: [rep('node-a')] });
    expect(p.status).toBe('placed');
    expect(p.actualNodes).toEqual(['node-a']);
    expect(p.reasons).toEqual([]);
  });

  it('is misplaced after a storage failover moved pods and data (the production case)', () => {
    const p = observeTenantPlacement(tenant(), {
      pods: [pod('node-b')],
      volumes: [vol({ attachedNode: 'node-b' })],
      replicas: [rep('node-b')],
    });
    expect(p.status).toBe('misplaced');
    expect(p.actualNodes).toEqual(['node-b']);
    expect(p.reasons).toEqual(['running on node-b', 'data on node-b']);
  });

  it('flags a STOPPED tenant whose data a backup pod dragged to another node', () => {
    const p = observeTenantPlacement(tenant(), {
      pods: [],
      volumes: [vol({ attached: false, attachedNode: null })],
      replicas: [rep('node-b', { running: false })],
    });
    expect(p.status).toBe('misplaced');
    expect(p.actualNodes).toEqual(['node-b']);
    expect(p.reasons).toEqual(['data on node-b']);
  });

  it('says the data is being copied while a locality rebuild has replicas on both', () => {
    const p = observeTenantPlacement(tenant(), {
      pods: [pod('node-b')],
      volumes: [vol({ attachedNode: 'node-b' })],
      replicas: [rep('node-a'), rep('node-b')],
    });
    expect(p.reasons).toEqual(['running on node-b', 'data being copied to node-b']);
  });

  it('ignores backup/restore Job pods and failed replicas', () => {
    const p = observeTenantPlacement(tenant(), {
      pods: [pod('node-a'), pod('node-b', { name: 'bk-files-x', controllerKind: 'Job' })],
      volumes: [vol()],
      replicas: [rep('node-a'), rep('node-b', { failed: true })],
    });
    expect(p.status).toBe('placed');
  });

  it('ignores pods that are not running and leftover volumes of a past PVC', () => {
    const p = observeTenantPlacement(tenant(), {
      pods: [pod('node-a'), pod('node-b', { phase: 'Pending' })],
      volumes: [vol(), vol({ volumeName: 'pvc-ghost', attachedNode: 'node-c', pvcRefLostAt: '2026-09-03T12:02:48Z' })],
      replicas: [rep('node-a'), rep('node-c', { volumeName: 'pvc-ghost' })],
    });
    expect(p.status).toBe('placed');
  });

  it('is unpinned when the tenant has no primary node', () => {
    const p = observeTenantPlacement(tenant({ pinnedNode: null }), { pods: [pod('node-b')], volumes: [], replicas: [] });
    expect(p.status).toBe('unpinned');
    expect(p.actualNodes).toEqual(['node-b']);
  });
});

describe('observeTenantPlacement — HA tier', () => {
  const ha = tenant({ storageTier: 'ha' });

  it('accepts a second replica elsewhere while it runs on the primary', () => {
    const p = observeTenantPlacement(ha, { pods: [pod('node-a')], volumes: [vol()], replicas: [rep('node-a'), rep('node-b')] });
    expect(p.status).toBe('placed');
  });

  it('reports a failover to the other node, and a primary with no replica', () => {
    const p = observeTenantPlacement(ha, {
      pods: [pod('node-b')], volumes: [vol({ attachedNode: 'node-b' })], replicas: [rep('node-b'), rep('node-c')],
    });
    expect(p.status).toBe('misplaced');
    expect(p.reasons).toEqual(['running on node-b', 'no data replica on node-a (data on node-b and node-c)']);
  });
});

describe('computePlacements', () => {
  it('reports every tenant unknown when the cluster read was incomplete', () => {
    const out = computePlacements({
      tenants: [tenant()], pods: [], volumes: [], replicas: [], readError: 'longhorn replicas: timeout',
    });
    expect(out.map((p) => p.status)).toEqual(['unknown']);
    expect(out[0]!.reasons).toEqual([]);
  });
});

describe('observeStorageFailovers', () => {
  it('reports each salvaged tenant volume once per remount timestamp, normalised to ISO', () => {
    const out = observeStorageFailovers({
      tenants: [tenant()],
      volumes: [
        vol({ remountRequestedAt: '2026-10-02T05:09:29Z' }),
        vol({ volumeName: 'pvc-2', remountRequestedAt: null }),
        vol({ volumeName: 'pvc-3', remountRequestedAt: 'garbage' }),
        vol({ volumeName: 'pvc-other', namespace: 'tenant-other', remountRequestedAt: '2026-10-02T05:09:29Z' }),
      ],
    });
    expect(out).toEqual([{
      tenantId: 't1', tenantName: 'Acme', volumeName: 'pvc-1', pvcName: `${NS}-storage`,
      remountRequestedAt: '2026-10-02T05:09:29.000Z',
    }]);
  });
});
