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
  attached: true, pvcRefLostAt: null, attachedNode: 'node-a', remountRequestedAt: null, scheduleFailure: null, ...over,
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

  it('says WHY the data is not following when Longhorn refused the copy (the production case)', () => {
    // Moved to node-a; pods and the attachment are there, the one replica is
    // still on node-b, and Longhorn cannot schedule the local copy.
    const p = observeTenantPlacement(tenant(), {
      pods: [pod('node-a')],
      volumes: [vol({ attachedNode: 'node-a', scheduleFailure: 'insufficient storage' })],
      replicas: [rep('node-b')],
    });
    expect(p.status).toBe('misplaced');
    expect(p.reasons).toEqual(['data on node-b; Longhorn cannot copy it to node-a: insufficient storage']);
  });

  it('names the node the volume is attached to as the copy\'s target, the primary when it is detached', () => {
    const attachedElsewhere = observeTenantPlacement(tenant(), {
      pods: [pod('node-c')],
      volumes: [vol({ attachedNode: 'node-c', scheduleFailure: 'insufficient storage' })],
      replicas: [rep('node-b')],
    });
    expect(attachedElsewhere.reasons).toContain('data on node-b; Longhorn cannot copy it to node-c: insufficient storage');
    const detached = observeTenantPlacement(tenant(), {
      pods: [],
      volumes: [vol({ attached: false, attachedNode: null, scheduleFailure: 'disks are unavailable' })],
      replicas: [rep('node-b', { running: false })],
    });
    expect(detached.reasons).toEqual(['data on node-b; Longhorn cannot copy it to node-a: disks are unavailable']);
  });

  it('does not read another tenant\'s or a leftover volume\'s scheduling failure into this one', () => {
    const p = observeTenantPlacement(tenant(), {
      pods: [pod('node-a')],
      volumes: [
        vol({ attachedNode: 'node-a' }),
        vol({ volumeName: 'pvc-other', namespace: 'tenant-other', scheduleFailure: 'insufficient storage' }),
        vol({ volumeName: 'pvc-ghost', pvcRefLostAt: '2026-09-03T12:02:48Z', scheduleFailure: 'insufficient storage' }),
      ],
      replicas: [rep('node-b')],
    });
    expect(p.reasons).toEqual(['data on node-b']);
  });

  it('does not blame a volume whose data is already where the tenant runs', () => {
    // Running on node-c (primary node-a). One volume is still on node-b with
    // nothing wrong; the other is already on node-c, and its own
    // Scheduled=False is about something else.
    const volumes = [
      vol({ volumeName: 'pvc-behind', attachedNode: 'node-c' }),
      vol({ volumeName: 'pvc-local', attachedNode: 'node-c', scheduleFailure: 'replica count exceeds the nodes available' }),
    ];
    const p = observeTenantPlacement(tenant(), {
      pods: [pod('node-c')],
      volumes,
      replicas: [rep('node-b', { volumeName: 'pvc-behind' }), rep('node-c', { volumeName: 'pvc-local' })],
    });
    expect(p.reasons).toEqual(['running on node-c', 'data on node-b and node-c']);
    // The same failure on the volume that IS behind is reported.
    const behind = observeTenantPlacement(tenant(), {
      pods: [pod('node-c')],
      volumes: [{ ...volumes[0]!, scheduleFailure: 'insufficient storage' }, { ...volumes[1]!, scheduleFailure: null }],
      replicas: [rep('node-b', { volumeName: 'pvc-behind' }), rep('node-c', { volumeName: 'pvc-local' })],
    });
    expect(behind.reasons).toEqual(['running on node-c', 'data on node-b and node-c; Longhorn cannot copy it to node-c: insufficient storage']);
  });

  it('a failed replica on the target is not a copy there', () => {
    const p = observeTenantPlacement(tenant(), {
      pods: [pod('node-a')],
      volumes: [vol({ attachedNode: 'node-a', scheduleFailure: 'insufficient storage' })],
      replicas: [rep('node-b'), rep('node-a', { failed: true, running: false })],
    });
    expect(p.reasons).toEqual(['data on node-b; Longhorn cannot copy it to node-a: insufficient storage']);
  });

  it('a placed tenant stays placed whatever Longhorn says about scheduling', () => {
    const p = observeTenantPlacement(tenant(), {
      pods: [pod('node-a')],
      volumes: [vol({ scheduleFailure: 'insufficient storage' })],
      replicas: [rep('node-a')],
    });
    expect(p.status).toBe('placed');
    expect(p.reasons).toEqual([]);
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
