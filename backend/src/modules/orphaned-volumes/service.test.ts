import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { detectOrphans } from './service.js';

// Schema mock so the dynamic-import path inside service.ts works.
vi.mock('../../db/schema.js', () => ({
  clients: { kubernetesNamespace: 'kubernetesNamespace', companyName: 'companyName' },
}));

function makeDb(rows: ReadonlyArray<{ ns: string | null; name: string }>): Database {
  return {
    select: () => ({ from: () => Promise.resolve(rows) }),
  } as unknown as Database;
}

interface MockOpts {
  pvs?: unknown[];
  namespaces?: string[];
  longhornVolumes?: unknown[];
  longhornReplicas?: unknown[];
}

function makeK8s(opts: MockOpts): K8sClients {
  return {
    core: {
      listPersistentVolume: vi.fn().mockResolvedValue({ items: opts.pvs ?? [] }),
      listNamespace: vi.fn().mockResolvedValue({
        items: (opts.namespaces ?? []).map((n) => ({ metadata: { name: n } })),
      }),
    },
    custom: {
      listNamespacedCustomObject: vi.fn().mockImplementation(async (req: { plural: string }) => {
        if (req.plural === 'volumes') return { items: opts.longhornVolumes ?? [] };
        if (req.plural === 'replicas') return { items: opts.longhornReplicas ?? [] };
        return { items: [] };
      }),
    },
  } as unknown as K8sClients;
}

describe('detectOrphans', () => {
  it('flags Released stale PV with no Longhorn backing — longhornVolumeName=null', async () => {
    // PV provisioned by a non-Longhorn driver (e.g. local-path) goes
    // Released, the namespace was deleted. We still flag it as orphan
    // but Longhorn-targeted operations (snapshot) must be a no-op.
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-localpath-orphan' },
        spec: { claimRef: { namespace: 'gone' }, capacity: { storage: '1Gi' } },
        status: { phase: 'Released', lastTransitionTime: new Date(Date.now() - 10 * 86400_000).toISOString() },
      }],
      namespaces: [],
      longhornVolumes: [],
    });
    const db = makeDb([]);

    const r = await detectOrphans(db, k8s);
    expect(r.totalCount).toBe(1);
    expect(r.orphans[0]).toMatchObject({
      pvName: 'pvc-localpath-orphan',
      longhornVolumeName: null,
      reason: 'namespace_deleted',
    });
  });

  it('flags PV whose namespace was deleted', async () => {
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-deleted-ns' },
        spec: {
          claimRef: { namespace: 'gone-ns', name: 'data' },
          capacity: { storage: '10Gi' },
          persistentVolumeReclaimPolicy: 'Retain',
        },
        status: { phase: 'Released', lastTransitionTime: new Date(Date.now() - 86400_000).toISOString() },
      }],
      namespaces: ['platform', 'longhorn-system'], // gone-ns missing
      longhornVolumes: [{
        metadata: { name: 'pvc-deleted-ns' },
        spec: { size: String(10 * 1024 ** 3) },
        status: { kubernetesStatus: { pvName: 'pvc-deleted-ns', namespace: 'gone-ns', pvcName: 'data' } },
      }],
      longhornReplicas: [{ spec: { volumeName: 'pvc-deleted-ns', nodeID: 'worker' }, status: { currentState: 'running' } }],
    });
    const db = makeDb([]);

    const r = await detectOrphans(db, k8s);

    expect(r.totalCount).toBe(1);
    expect(r.orphans[0]).toMatchObject({
      pvName: 'pvc-deleted-ns',
      longhornVolumeName: 'pvc-deleted-ns',
      namespace: 'gone-ns',
      reason: 'namespace_deleted',
      nodes: ['worker'],
      ownerLabel: 'Platform System (gone-ns)',
    });
  });

  it('flags tenant PV whose client row was deleted but namespace still exists', async () => {
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-orphan-tenant' },
        spec: {
          claimRef: { namespace: 'client-stale', name: 'data' },
          capacity: { storage: '5Gi' },
        },
        status: { phase: 'Bound', lastTransitionTime: new Date().toISOString() },
      }],
      namespaces: ['client-stale'],
      longhornVolumes: [{ metadata: { name: 'pvc-orphan-tenant' }, status: { kubernetesStatus: { pvName: 'pvc-orphan-tenant' } } }],
    });
    const db = makeDb([]); // no client rows

    const r = await detectOrphans(db, k8s);
    expect(r.orphans[0]).toMatchObject({
      reason: 'client_record_deleted',
      ownerLabel: 'Platform System (client-stale)',
    });
  });

  it('flags PV stuck in Released phase past the stale threshold', async () => {
    const old = new Date(Date.now() - 10 * 86400_000).toISOString(); // 10 days
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-stale' },
        spec: { claimRef: { namespace: 'platform', name: 'old-data' }, capacity: { storage: '1Gi' } },
        status: { phase: 'Released', lastTransitionTime: old },
      }],
      namespaces: ['platform'],
      longhornVolumes: [{ metadata: { name: 'pvc-stale' }, status: { kubernetesStatus: { pvName: 'pvc-stale' } } }],
    });
    const db = makeDb([]);

    const r = await detectOrphans(db, k8s, { stalePvThresholdDays: 7 });
    expect(r.orphans[0].reason).toBe('pv_released_stale');
    expect(r.orphans[0].ageDays).toBeGreaterThanOrEqual(10);
  });

  it('does NOT flag a Bound PV whose client row exists', async () => {
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-healthy' },
        spec: { claimRef: { namespace: 'client-acme', name: 'data' }, capacity: { storage: '2Gi' } },
        status: { phase: 'Bound', lastTransitionTime: new Date().toISOString() },
      }],
      namespaces: ['client-acme'],
      longhornVolumes: [{ metadata: { name: 'pvc-healthy' }, status: { kubernetesStatus: { pvName: 'pvc-healthy' } } }],
    });
    const db = makeDb([{ ns: 'client-acme', name: 'Acme Co' }]);

    const r = await detectOrphans(db, k8s);
    expect(r.totalCount).toBe(0);
  });

  it('flags Longhorn volume with no matching PV', async () => {
    const k8s = makeK8s({
      pvs: [],
      namespaces: ['longhorn-system'],
      longhornVolumes: [{
        metadata: { name: 'orphan-lh-vol' },
        spec: { size: String(3 * 1024 ** 3) },
        status: { kubernetesStatus: { pvName: '', namespace: '', pvcName: '' } },
      }],
      longhornReplicas: [{ spec: { volumeName: 'orphan-lh-vol', nodeID: 'staging1' }, status: { currentState: 'running' } }],
    });
    const db = makeDb([]);

    const r = await detectOrphans(db, k8s);
    expect(r.totalCount).toBe(1);
    expect(r.orphans[0]).toMatchObject({
      pvName: null,
      longhornVolumeName: 'orphan-lh-vol',
      reason: 'longhorn_volume_unbound',
      sizeBytes: 3 * 1024 ** 3,
      nodes: ['staging1'],
    });
  });

  it('attributes a tenant orphan to its client when the client row still exists', async () => {
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-acme' },
        spec: { claimRef: { namespace: 'client-acme', name: 'data' }, capacity: { storage: '5Gi' } },
        status: { phase: 'Released', lastTransitionTime: new Date(Date.now() - 10 * 86400_000).toISOString() },
      }],
      namespaces: ['client-acme'],
      longhornVolumes: [{ metadata: { name: 'pvc-acme' }, status: { kubernetesStatus: { pvName: 'pvc-acme' } } }],
    });
    const db = makeDb([{ ns: 'client-acme', name: 'Acme Co' }]);

    const r = await detectOrphans(db, k8s);
    expect(r.orphans[0]).toMatchObject({
      reason: 'pv_released_stale',
      ownerLabel: 'Acme Co',
    });
  });

  it('aggregates totalBytes and sorts orphans largest-first', async () => {
    const k8s = makeK8s({
      pvs: [
        {
          metadata: { name: 'small' },
          spec: { claimRef: { namespace: 'gone' }, capacity: { storage: '1Gi' } },
          status: { phase: 'Released', lastTransitionTime: new Date().toISOString() },
        },
        {
          metadata: { name: 'big' },
          spec: { claimRef: { namespace: 'gone' }, capacity: { storage: '50Gi' } },
          status: { phase: 'Released', lastTransitionTime: new Date().toISOString() },
        },
      ],
      namespaces: [],
      longhornVolumes: [
        { metadata: { name: 'small' }, status: { kubernetesStatus: { pvName: 'small' } } },
        { metadata: { name: 'big' }, status: { kubernetesStatus: { pvName: 'big' } } },
      ],
    });
    const db = makeDb([]);

    const r = await detectOrphans(db, k8s);
    expect(r.totalCount).toBe(2);
    expect(r.orphans[0].pvName).toBe('big');
    expect(r.orphans[1].pvName).toBe('small');
    expect(r.totalBytes).toBe(51 * 1024 ** 3);
  });
});
