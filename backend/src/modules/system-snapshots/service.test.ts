import { describe, it, expect, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  assertLonghornVolume,
  listSystemPvcSnapshots,
  listSnapshotsForVolume,
  pruneVolumeSnapshots,
  takeSnapshot,
  deleteSnapshot,
} from './service.js';

interface MockOpts {
  pvcByNs?: Record<string, unknown[]>;
  longhornVolumes?: unknown[];
  longhornSnapshots?: unknown[];
  longhornRecurringJobs?: unknown[];
}

function makeK8s(opts: MockOpts): { k8s: K8sClients; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const createSpy = vi.fn().mockResolvedValue({});
  const deleteSpy = vi.fn().mockResolvedValue({});
  const getSpy = vi.fn().mockImplementation(({ name }: { name: string }) => {
    const items = (opts.longhornSnapshots ?? []) as Array<{ metadata?: { name?: string }; spec?: { volume?: string } }>;
    const found = items.find((s) => s.metadata?.name === name);
    if (!found) {
      const err = new Error('NotFound') as Error & { code: number };
      err.code = 404;
      return Promise.reject(err);
    }
    return Promise.resolve(found);
  });
  const k8s = {
    core: {
      listNamespacedPersistentVolumeClaim: vi.fn().mockImplementation(({ namespace }: { namespace: string }) =>
        Promise.resolve({ items: opts.pvcByNs?.[namespace] ?? [] }),
      ),
    },
    custom: {
      listNamespacedCustomObject: vi.fn().mockImplementation(({ plural }: { plural: string }) => {
        if (plural === 'volumes') return Promise.resolve({ items: opts.longhornVolumes ?? [] });
        if (plural === 'snapshots') return Promise.resolve({ items: opts.longhornSnapshots ?? [] });
        if (plural === 'recurringjobs') return Promise.resolve({ items: opts.longhornRecurringJobs ?? [] });
        return Promise.resolve({ items: [] });
      }),
      // CNPG cluster lookup is cluster-scoped — return empty by default
      // so existing tests don't need to mock CNPG state.
      listClusterCustomObject: vi.fn().mockResolvedValue({ items: [] }),
      getNamespacedCustomObject: getSpy,
      createNamespacedCustomObject: createSpy,
      deleteNamespacedCustomObject: deleteSpy,
    },
  } as unknown as K8sClients;
  return { k8s, spies: { create: createSpy, delete: deleteSpy, get: getSpy } };
}

describe('listSystemPvcSnapshots', () => {
  it('aggregates snapshot count + bytes per system PVC and resolves recurring jobs', async () => {
    const { k8s } = makeK8s({
      pvcByNs: {
        platform: [{
          metadata: { name: 'data-postgres-0', namespace: 'platform' },
          spec: { volumeName: 'pvc-pg' },
          status: { capacity: { storage: '10Gi' } },
        }],
        mail: [{
          metadata: { name: 'data-stalwart-mail-0', namespace: 'mail' },
          spec: { volumeName: 'pvc-mail' },
          status: { capacity: { storage: '20Gi' } },
        }],
      },
      longhornVolumes: [
        {
          metadata: { name: 'pvc-pg', labels: { 'recurring-job-group.longhorn.io/default': 'enabled' } },
          spec: { size: String(10 * 1024 ** 3) },
          status: { robustness: 'healthy' },
        },
        {
          metadata: { name: 'pvc-mail', labels: { 'recurring-job-group.longhorn.io/default': 'enabled' } },
          spec: { size: String(20 * 1024 ** 3) },
          status: { robustness: 'degraded' },
        },
      ],
      longhornSnapshots: [
        // 3 snapshots on pvc-pg
        { metadata: { name: 'pg-1' }, spec: { volume: 'pvc-pg' }, status: { creationTime: '2026-05-01T01:00:00Z', size: '1Gi', readyToUse: true } },
        { metadata: { name: 'pg-2' }, spec: { volume: 'pvc-pg' }, status: { creationTime: '2026-05-01T02:00:00Z', size: '500Mi', readyToUse: true } },
        { metadata: { name: 'pg-3' }, spec: { volume: 'pvc-pg' }, status: { creationTime: '2026-05-01T03:00:00Z', size: '500Mi', readyToUse: true } },
        // 1 marked-removed snapshot on pvc-mail (excluded from count)
        { metadata: { name: 'mail-removed' }, spec: { volume: 'pvc-mail' }, status: { markRemoved: true, size: '4Gi' } },
        // 5 usable snapshots on pvc-mail
        ...Array.from({ length: 5 }, (_, i) => ({
          metadata: { name: `mail-${i}` },
          spec: { volume: 'pvc-mail' },
          status: { creationTime: `2026-05-0${i + 1}T00:00:00Z`, size: '1Gi', readyToUse: true },
        })),
      ],
      longhornRecurringJobs: [
        { metadata: { name: 'hourly-snap' }, spec: { task: 'snapshot', cron: '5 * * * *', retain: 24, groups: ['default'] } },
        { metadata: { name: 'daily-backup' }, spec: { task: 'backup', cron: '0 2 * * *', retain: 14, groups: ['default'] } },
      ],
    });
    const items = await listSystemPvcSnapshots(k8s);
    // sorted by snapshotBytesTotal desc — mail (5 GiB usable) > pg (2 GiB)
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({
      pvcName: 'data-stalwart-mail-0',
      snapshotCount: 5,
      degraded: true,
    });
    expect(items[0].snapshotBytesTotal).toBe(5 * 1024 ** 3);
    expect(items[0].recurringJobs.sort()).toEqual(['daily-backup', 'hourly-snap']);
    expect(items[1]).toMatchObject({
      pvcName: 'data-postgres-0',
      snapshotCount: 3,
      degraded: false,
    });
    expect(items[1].snapshotBytesTotal).toBe(1 * 1024 ** 3 + 500 * 1024 ** 2 * 2);
  });

  it('handles missing Longhorn CRDs gracefully', async () => {
    const { k8s } = makeK8s({
      pvcByNs: { platform: [{ metadata: { name: 'pvc-x', namespace: 'platform' }, spec: { volumeName: 'vol-x' } }] },
    });
    const items = await listSystemPvcSnapshots(k8s);
    expect(items[0]).toMatchObject({ pvcName: 'pvc-x', snapshotCount: 0, snapshotBytesTotal: 0, recurringJobs: [] });
  });
});

describe('listSnapshotsForVolume', () => {
  it('filters to one volume and sorts newest first', async () => {
    const { k8s } = makeK8s({
      longhornSnapshots: [
        { metadata: { name: 'a-old' }, spec: { volume: 'vol-a' }, status: { creationTime: '2026-04-01T00:00:00Z', size: '1Gi', readyToUse: true } },
        { metadata: { name: 'a-new' }, spec: { volume: 'vol-a' }, status: { creationTime: '2026-05-01T00:00:00Z', size: '1Gi', readyToUse: true } },
        { metadata: { name: 'b-1' }, spec: { volume: 'vol-b' }, status: { creationTime: '2026-05-01T00:00:00Z', size: '1Gi', readyToUse: true } },
      ],
    });
    const snaps = await listSnapshotsForVolume(k8s, 'vol-a');
    expect(snaps.length).toBe(2);
    expect(snaps[0].snapshotName).toBe('a-new'); // newest first
    expect(snaps[1].snapshotName).toBe('a-old');
  });
});

describe('pruneVolumeSnapshots', () => {
  it('keeps the N newest snapshots and deletes the rest', async () => {
    const snaps = Array.from({ length: 5 }, (_, i) => ({
      metadata: { name: `s-${i}` },
      spec: { volume: 'vol-z' },
      status: { creationTime: `2026-05-0${i + 1}T00:00:00Z`, size: '1Gi' },
    }));
    const { k8s, spies } = makeK8s({ longhornSnapshots: snaps });

    const result = await pruneVolumeSnapshots(k8s, 'vol-z', 2);

    // Newest 2 (s-4, s-3) kept; older 3 deleted.
    expect(result.kept.sort()).toEqual(['s-3', 's-4']);
    expect(result.deleted.sort()).toEqual(['s-0', 's-1', 's-2']);
    expect(spies.delete).toHaveBeenCalledTimes(3);
  });

  it('keepNewest=0 deletes everything', async () => {
    const { k8s, spies } = makeK8s({
      longhornSnapshots: [
        { metadata: { name: 's1' }, spec: { volume: 'vol-q' }, status: { creationTime: '2026-05-01T00:00:00Z' } },
        { metadata: { name: 's2' }, spec: { volume: 'vol-q' }, status: { creationTime: '2026-05-02T00:00:00Z' } },
      ],
    });
    const result = await pruneVolumeSnapshots(k8s, 'vol-q', 0);
    expect(result.kept).toEqual([]);
    expect(result.deleted.sort()).toEqual(['s1', 's2']);
    expect(spies.delete).toHaveBeenCalledTimes(2);
  });
});

describe('deleteSnapshot ownership guard', () => {
  it('refuses to delete a snapshot belonging to a different volume', async () => {
    const { k8s, spies } = makeK8s({
      longhornSnapshots: [
        { metadata: { name: 'tenant-snap' }, spec: { volume: 'pvc-tenant-data' } },
      ],
    });
    await expect(deleteSnapshot(k8s, 'pvc-postgres-0', 'tenant-snap'))
      .rejects.toThrow(/belongs to volume 'pvc-tenant-data'/);
    expect(spies.delete).not.toHaveBeenCalled();
  });

  it('deletes when the snapshot is on the expected volume', async () => {
    const { k8s, spies } = makeK8s({
      longhornSnapshots: [
        { metadata: { name: 'pg-snap-1' }, spec: { volume: 'pvc-postgres-0' } },
      ],
    });
    await deleteSnapshot(k8s, 'pvc-postgres-0', 'pg-snap-1');
    expect(spies.delete).toHaveBeenCalledWith(expect.objectContaining({ name: 'pg-snap-1' }));
  });

  it('throws 404 when the snapshot does not exist', async () => {
    const { k8s, spies } = makeK8s({ longhornSnapshots: [] });
    await expect(deleteSnapshot(k8s, 'pvc-x', 'missing'))
      .rejects.toThrow(/not found/);
    expect(spies.delete).not.toHaveBeenCalled();
  });
});

describe('takeSnapshot', () => {
  it('creates a Longhorn Snapshot CR with sanitised user label', async () => {
    const { k8s, spies } = makeK8s({});
    const result = await takeSnapshot(k8s, 'vol-x', 'pre-upgrade test/123!');
    expect(result.snapshotName).toMatch(/^manual-\d+-vol-x/);
    const call = spies.create.mock.calls[0][0] as { body: { metadata: { labels: Record<string, string> }; spec: { volume: string } } };
    expect(call.body.metadata.labels['insula.host/user-label']).toBe('pre-upgrade_test_123_');
    expect(call.body.spec.volume).toBe('vol-x');
  });
});

// The mail store sits on node-local `local-path` storage — no Longhorn volume.
// Snapshotting it reached the operator as a 500 "Rejected by an admission
// webhook" (Longhorn's mutator: "failed to get volume"), with advice about
// degraded volumes (v2026.10.3-rc.2 VM run, integration-system-snapshots).
describe('volumes Longhorn cannot snapshot', () => {
  const pvcs = {
    platform: [{ metadata: { name: 'system-db-1', namespace: 'platform' }, spec: { volumeName: 'pvc-db' }, status: { capacity: { storage: '10Gi' } } }],
    mail: [{ metadata: { name: 'mail-stack-data', namespace: 'mail' }, spec: { volumeName: 'pvc-local' }, status: { capacity: { storage: '20Gi' } } }],
  };
  const lhVolumes = [{ metadata: { name: 'pvc-db', labels: {} }, spec: { size: '10737418240' }, status: { robustness: 'healthy' } }];

  it('listing marks a PVC with no Longhorn volume as not snapshot-capable', async () => {
    const { k8s } = makeK8s({ pvcByNs: pvcs, longhornVolumes: lhVolumes });
    const rows = await listSystemPvcSnapshots(k8s);
    const byPvc = Object.fromEntries(rows.map((r) => [r.pvcName, r.snapshotCapable]));
    expect(byPvc).toEqual({ 'system-db-1': true, 'mail-stack-data': false });
  });

  it('a failed Longhorn volume LIST keeps every row capable — unknown is not "no"', async () => {
    const { k8s } = makeK8s({ pvcByNs: pvcs, longhornVolumes: lhVolumes });
    const list = (k8s.custom as unknown as { listNamespacedCustomObject: ReturnType<typeof vi.fn> }).listNamespacedCustomObject;
    list.mockImplementation(({ plural }: { plural: string }) =>
      plural === 'volumes' ? Promise.reject(new Error('apiserver timeout')) : Promise.resolve({ items: [] }));
    const rows = await listSystemPvcSnapshots(k8s);
    expect(rows.every((r) => r.snapshotCapable)).toBe(true);
  });

  it('assertLonghornVolume: no Longhorn volume → 409 VOLUME_NOT_SNAPSHOTTABLE naming the mail backup', async () => {
    const { k8s } = makeK8s({});
    await expect(assertLonghornVolume(k8s, 'pvc-local')).rejects.toMatchObject({
      code: 'VOLUME_NOT_SNAPSHOTTABLE',
      status: 409,
      remediation: expect.stringContaining('mail backup'),
    });
  });

  it('assertLonghornVolume: an existing Longhorn volume passes', async () => {
    const { k8s, spies } = makeK8s({});
    spies.get.mockResolvedValueOnce({ metadata: { name: 'pvc-db' } });
    await expect(assertLonghornVolume(k8s, 'pvc-db')).resolves.toBeUndefined();
  });

  it('assertLonghornVolume: any other lookup failure is rethrown, not called "not snapshottable"', async () => {
    const { k8s, spies } = makeK8s({});
    spies.get.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { code: 403 }));
    await expect(assertLonghornVolume(k8s, 'pvc-db')).rejects.toThrow('forbidden');
  });
});
