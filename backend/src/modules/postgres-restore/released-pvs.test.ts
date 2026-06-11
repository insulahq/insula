import { describe, it, expect, vi } from 'vitest';
import { listSupersededSystemPvs, reclaimSupersededSystemPv } from './released-pvs.js';

const SUPERSEDED = {
  metadata: { name: 'pvc-old-sysdb', creationTimestamp: '2026-06-11T00:00:00Z' },
  status: { phase: 'Released' },
  spec: {
    claimRef: { namespace: 'platform', name: 'system-db-1' },
    capacity: { storage: '20Gi' },
    storageClassName: 'longhorn-system-local',
  },
};
const LIVE_SYSTEM = {
  metadata: { name: 'pvc-live-sysdb' },
  status: { phase: 'Bound' },
  spec: { claimRef: { namespace: 'platform', name: 'system-db-1' }, capacity: { storage: '20Gi' } },
};
const TENANT_RELEASED = {
  metadata: { name: 'pvc-tenant' },
  status: { phase: 'Released' },
  spec: { claimRef: { namespace: 'tenant-x', name: 'tenant-x-storage' }, capacity: { storage: '2Gi' } },
};

function makeK8s(pvs: unknown[], readPv?: unknown) {
  return {
    core: {
      listPersistentVolume: vi.fn(async () => ({ items: pvs })),
      readPersistentVolume: vi.fn(async () => {
        if (readPv === undefined) throw new Error('404');
        return readPv;
      }),
      deletePersistentVolume: vi.fn(async () => ({})),
    },
    custom: {
      deleteNamespacedCustomObject: vi.fn(async () => ({})),
    },
  } as never;
}

describe('listSupersededSystemPvs', () => {
  it('lists only Released platform/system-db-* PVs', async () => {
    const k8s = makeK8s([SUPERSEDED, LIVE_SYSTEM, TENANT_RELEASED]);
    const r = await listSupersededSystemPvs(k8s);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'pvc-old-sysdb', claimName: 'system-db-1', size: '20Gi' });
  });
});

describe('reclaimSupersededSystemPv', () => {
  it('deletes PV + Longhorn volume CR after re-verification', async () => {
    const k8s = makeK8s([], SUPERSEDED);
    const r = await reclaimSupersededSystemPv(k8s, 'pvc-old-sysdb', 'pvc-old-sysdb');
    expect(r).toEqual({ pvDeleted: true, longhornVolumeDeleted: true });
    const mocks = k8s as unknown as {
      core: { deletePersistentVolume: ReturnType<typeof vi.fn> };
      custom: { deleteNamespacedCustomObject: ReturnType<typeof vi.fn> };
    };
    expect(mocks.core.deletePersistentVolume).toHaveBeenCalled();
    expect(mocks.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ plural: 'volumes', name: 'pvc-old-sysdb' }),
    );
  });

  it('rejects confirm-name mismatch before any read/delete', async () => {
    const k8s = makeK8s([], SUPERSEDED);
    await expect(reclaimSupersededSystemPv(k8s, 'pvc-old-sysdb', 'wrong'))
      .rejects.toMatchObject({ code: 'CONFIRM_NAME_MISMATCH' });
    const mocks = k8s as unknown as { core: { deletePersistentVolume: ReturnType<typeof vi.fn> } };
    expect(mocks.core.deletePersistentVolume).not.toHaveBeenCalled();
  });

  it('refuses a Bound system PV (never a generic delete primitive)', async () => {
    const k8s = makeK8s([], LIVE_SYSTEM);
    await expect(reclaimSupersededSystemPv(k8s, 'pvc-live-sysdb', 'pvc-live-sysdb'))
      .rejects.toMatchObject({ code: 'PV_NOT_RECLAIMABLE' });
  });

  it('refuses a Released non-system PV', async () => {
    const k8s = makeK8s([], TENANT_RELEASED);
    await expect(reclaimSupersededSystemPv(k8s, 'pvc-tenant', 'pvc-tenant'))
      .rejects.toMatchObject({ code: 'PV_NOT_RECLAIMABLE' });
  });

  it('tolerates an absent Longhorn volume CR (local-path DinD)', async () => {
    const k8s = makeK8s([], SUPERSEDED);
    (k8s as unknown as { custom: { deleteNamespacedCustomObject: ReturnType<typeof vi.fn> } })
      .custom.deleteNamespacedCustomObject.mockRejectedValue(new Error('404'));
    const r = await reclaimSupersededSystemPv(k8s, 'pvc-old-sysdb', 'pvc-old-sysdb');
    expect(r).toEqual({ pvDeleted: true, longhornVolumeDeleted: false });
  });

  it('404s on an unknown PV', async () => {
    const k8s = makeK8s([]);
    await expect(reclaimSupersededSystemPv(k8s, 'pvc-nope', 'pvc-nope'))
      .rejects.toMatchObject({ code: 'PV_NOT_FOUND' });
  });
});
