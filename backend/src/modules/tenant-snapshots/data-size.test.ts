import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  MAX_SELECTOR_VOLUMES,
  longhornVolumeSelector,
  parseLonghornSnapshotSize,
  readLonghornSnapshotSizes,
  resolveLonghornNames,
} from './data-size.js';

vi.mock('../system-settings/service.js', () => ({
  getSettings: vi.fn(async () => ({ snapshotExpiryHours: 48 })),
}));

describe('parseLonghornSnapshotSize', () => {
  it('reads the integer Longhorn v1.12 reports (a real DEV value)', () => {
    expect(parseLonghornSnapshotSize(67399680)).toBe(67399680);
    expect(parseLonghornSnapshotSize('30441472')).toBe(30441472);
  });

  it('★ keeps a measured 0 as 0', () => {
    expect(parseLonghornSnapshotSize(0)).toBe(0);
    expect(parseLonghornSnapshotSize('0')).toBe(0);
  });

  it('★ reads anything else as unknown (null), never as 0', () => {
    for (const v of [undefined, null, '', 'garbage', '1.5Gi', -1, 1.5, Number.NaN, {}]) {
      expect(parseLonghornSnapshotSize(v)).toBeNull();
    }
  });
});

describe('longhornVolumeSelector', () => {
  it('builds one set-based selector, deduplicated and sorted', () => {
    expect(longhornVolumeSelector(['pvc-b', 'pvc-a', 'pvc-b'])).toBe('longhornvolume in (pvc-a,pvc-b)');
  });

  it('skips the call when there is nothing to list', () => {
    expect(longhornVolumeSelector([])).toBeNull();
  });

  it('drops anything that is not a plain volume name instead of splicing it into the selector', () => {
    expect(longhornVolumeSelector(['pvc-a', 'x,longhornvolume!=y', 'A B'])).toBe('longhornvolume in (pvc-a)');
  });

  it('lists the whole namespace past the selector cap (still one call)', () => {
    const many = Array.from({ length: MAX_SELECTOR_VOLUMES + 1 }, (_, i) => `pvc-${i}`);
    expect(longhornVolumeSelector(many)).toBeUndefined();
  });
});

describe('readLonghornSnapshotSizes', () => {
  it('★ makes exactly ONE list call for any number of rows', async () => {
    const list = vi.fn(async () => ({
      items: [
        { metadata: { name: 'snapshot-1' }, status: { size: 67399680 } },
        { metadata: { name: 'snapshot-2' }, status: { size: 0 } },
        { metadata: { name: 'snapshot-3' }, status: {} },
      ],
    }));
    const k8s = { custom: { listNamespacedCustomObject: list } } as unknown as K8sClients;
    const sizes = await readLonghornSnapshotSizes(k8s, ['pvc-a', 'pvc-a', 'pvc-b']);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      group: 'longhorn.io', namespace: 'longhorn-system', plural: 'snapshots',
      labelSelector: 'longhornvolume in (pvc-a,pvc-b)',
    }));
    expect(sizes.get('snapshot-1')).toBe(67399680);
    expect(sizes.get('snapshot-2')).toBe(0);
    expect(sizes.get('snapshot-3')).toBeNull();
  });

  it('does not call k8s at all with no volumes', async () => {
    const list = vi.fn();
    const k8s = { custom: { listNamespacedCustomObject: list } } as unknown as K8sClients;
    expect((await readLonghornSnapshotSizes(k8s, [])).size).toBe(0);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('resolveLonghornNames', () => {
  const k8sWith = (handle: string | undefined) => ({
    custom: { getClusterCustomObject: vi.fn(async () => ({ status: { snapshotHandle: handle } })) },
  }) as unknown as K8sClients;

  it('reads the volume + snapshot out of the content handle', async () => {
    expect(await resolveLonghornNames(k8sWith('snap://pvc-a/snapshot-1'), 'snapcontent-1'))
      .toEqual({ volumeName: 'pvc-a', snapshotName: 'snapshot-1' });
  });

  it('returns null for a missing or non-snap handle', async () => {
    expect(await resolveLonghornNames(k8sWith(undefined), 'c')).toBeNull();
    expect(await resolveLonghornNames(k8sWith('bak://pvc-a/backup-1'), 'c')).toBeNull();
  });
});

// ─── listSnapshots wiring ───────────────────────────────────────────────

import { listSnapshots } from './service.js';
import { tenants, tenantVolumeSnapshots } from '../../db/schema.js';

type Row = Record<string, unknown>;

function snapRow(over: Row): Row {
  return {
    id: 's', tenantId: 't1', namespace: 'tenant-t1', pvcName: 'tenant-t1-storage',
    volumeSnapshotName: 'tvs-s', label: null, status: 'ready', sizeBytes: 2147483648,
    lastError: null, longhornVolumeName: null, longhornSnapshotName: null, triggeredByUserId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), readyAt: new Date('2026-01-01T00:00:05Z'),
    expiresAt: new Date('2026-01-03T00:00:00Z'),
    ...over,
  };
}

function fakeDb(rows: Row[]) {
  const updates: Array<{ patch: Row }> = [];
  const db = {
    select: () => {
      let table: unknown;
      const chain: Record<string, unknown> = {
        from: (t: unknown) => { table = t; return chain; },
        where: () => chain,
        limit: async () => (table === tenants ? [{ id: 't1', kubernetesNamespace: 'tenant-t1' }] : []),
        orderBy: async () => (table === tenantVolumeSnapshots ? rows : []),
      };
      return chain;
    },
    update: () => ({ set: (patch: Row) => ({ where: async () => { updates.push({ patch }); } }) }),
  };
  return { db, updates };
}

describe('listSnapshots — data size', () => {
  let listVs: ReturnType<typeof vi.fn>;
  let listLh: ReturnType<typeof vi.fn>;
  let getVsc: ReturnType<typeof vi.fn>;
  let k8s: K8sClients;

  beforeEach(() => {
    listVs = vi.fn(async () => ({
      items: [{ metadata: { name: 'tvs-legacy' }, status: { readyToUse: true, boundVolumeSnapshotContentName: 'snapcontent-legacy' } }],
    }));
    listLh = vi.fn(async () => ({
      items: [
        { metadata: { name: 'snapshot-resolved' }, status: { size: 67399680 } },
        { metadata: { name: 'snapshot-legacy' }, status: { size: 0 } },
      ],
    }));
    getVsc = vi.fn(async () => ({ status: { snapshotHandle: 'snap://pvc-a/snapshot-legacy' } }));
    k8s = {
      custom: {
        listNamespacedCustomObject: vi.fn((a: { plural: string }) => (a.plural === 'snapshots' ? listLh(a) : listVs(a))),
        getClusterCustomObject: getVsc,
      },
    } as unknown as K8sClients;
  });

  it('★ measures resolved rows, resolves legacy rows once, and keeps unknown distinct from 0', async () => {
    const { db, updates } = fakeDb([
      snapRow({ id: 'resolved', volumeSnapshotName: 'tvs-resolved', longhornVolumeName: 'pvc-a', longhornSnapshotName: 'snapshot-resolved' }),
      snapRow({ id: 'legacy', volumeSnapshotName: 'tvs-legacy' }),
      snapRow({ id: 'gone', volumeSnapshotName: 'tvs-gone' }),
      snapRow({ id: 'creating', volumeSnapshotName: 'tvs-creating', status: 'creating', sizeBytes: 0 }),
    ]);
    const { snapshots } = await listSnapshots({ db: db as never, k8s }, 't1', { withDataSize: true });
    const by = Object.fromEntries(snapshots.map((s) => [s.id, s.dataSizeBytes]));

    expect(by.resolved).toBe(67399680);
    expect(by.legacy).toBe(0); // measured zero — not "unknown"
    expect(by.gone).toBeNull(); // its VolumeSnapshot is gone: unknown
    expect(by.creating).toBeNull();
    // The provisioned size is untouched — data size is an addition, not a swap.
    expect(snapshots.find((s) => s.id === 'resolved')!.sizeBytes).toBe(2147483648);

    // One Longhorn list; one VolumeSnapshot list; one content GET for the
    // single legacy row that could be resolved — whose names are now stored.
    expect(listLh).toHaveBeenCalledTimes(1);
    expect(listVs).toHaveBeenCalledTimes(1);
    expect(getVsc).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual({ patch: { longhornVolumeName: 'pvc-a', longhornSnapshotName: 'snapshot-legacy' } });
  });

  it('★ a Longhorn outage reads as unknown for every row, never 0', async () => {
    listLh.mockRejectedValueOnce(new Error('connection refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb([snapRow({ id: 'r', longhornVolumeName: 'pvc-a', longhornSnapshotName: 'snapshot-resolved' })]);
    const { snapshots } = await listSnapshots({ db: db as never, k8s }, 't1', { withDataSize: true });
    expect(snapshots[0]!.dataSizeBytes).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a snapshot turning ready resolves its Longhorn names even on an internal poll', async () => {
    // The create watcher polls without withDataSize; resolving here is what
    // lets the admin cross-tenant list measure a snapshot nobody has listed.
    listVs.mockResolvedValueOnce({
      items: [{ metadata: { name: 'tvs-new' }, status: { readyToUse: true, restoreSize: '2Gi', boundVolumeSnapshotContentName: 'snapcontent-new' } }],
    });
    getVsc.mockResolvedValueOnce({ status: { snapshotHandle: 'snap://pvc-a/snapshot-new' } });
    const { db, updates } = fakeDb([snapRow({ id: 'new', volumeSnapshotName: 'tvs-new', status: 'creating', sizeBytes: 0 })]);
    const { snapshots } = await listSnapshots({ db: db as never, k8s }, 't1');
    expect(snapshots[0]!.status).toBe('ready');
    expect(getVsc).toHaveBeenCalledTimes(1);
    expect(listLh).not.toHaveBeenCalled();
    expect(updates[0]!.patch).toMatchObject({
      status: 'ready', sizeBytes: 2 * 1024 ** 3, longhornVolumeName: 'pvc-a', longhornSnapshotName: 'snapshot-new',
    });
  });

  it('internal pollers (no withDataSize) make no Longhorn call at all', async () => {
    const { db } = fakeDb([snapRow({ id: 'r', longhornVolumeName: 'pvc-a', longhornSnapshotName: 'snapshot-resolved' })]);
    const { snapshots } = await listSnapshots({ db: db as never, k8s }, 't1');
    expect(listLh).not.toHaveBeenCalled();
    expect(getVsc).not.toHaveBeenCalled();
    expect(snapshots[0]!.dataSizeBytes).toBeNull();
  });
});
