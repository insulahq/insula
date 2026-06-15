import { describe, it, expect, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  parseSnapshotHandle,
  assertSnapshotRevertable,
  revertVolumeToSnapshot,
  resolveLonghornSnapshotFromCsi,
  RevertError,
} from './longhorn-revert.js';

/** Build a fake K8sClients whose custom-object reads are driven by handler fns.
 *  `volumes` reads can be scripted (consumed in order) so a single test can walk
 *  a volume through detached → owner → maintenance-attached. */
function makeK8s(opts: {
  snapshot?: unknown | (() => never);
  volumeScript?: unknown[];
  volume?: unknown;
  volumeAttachment?: unknown;
  volumeSnapshot?: unknown | (() => never);
  volumeSnapshotContent?: unknown;
}): K8sClients {
  let volIdx = 0;
  const getNs = async (a: { plural: string; name: string }) => {
    if (a.plural === 'snapshots') {
      if (typeof opts.snapshot === 'function') return (opts.snapshot as () => never)();
      return opts.snapshot;
    }
    if (a.plural === 'volumeattachments') return opts.volumeAttachment ?? { spec: { attachmentTickets: {} } };
    if (a.plural === 'volumes') {
      if (opts.volumeScript) return opts.volumeScript[Math.min(volIdx++, opts.volumeScript.length - 1)];
      return opts.volume;
    }
    if (a.plural === 'volumesnapshots') {
      if (typeof opts.volumeSnapshot === 'function') return (opts.volumeSnapshot as () => never)();
      return opts.volumeSnapshot;
    }
    throw new Error(`unexpected getNs plural ${a.plural}`);
  };
  const getCluster = async (a: { plural: string }) => {
    if (a.plural === 'volumesnapshotcontents') return opts.volumeSnapshotContent;
    throw new Error(`unexpected getCluster plural ${a.plural}`);
  };
  return { custom: { getNamespacedCustomObject: getNs, getClusterCustomObject: getCluster } } as unknown as K8sClients;
}

const okFetch = () => vi.fn(async () => ({ ok: true, status: 200, text: async () => '' } as unknown as Response));

describe('parseSnapshotHandle', () => {
  it('parses snap://<volume>/<snapshot>', () => {
    expect(parseSnapshotHandle('snap://pvc-abc/snapshot-123'))
      .toEqual({ volumeName: 'pvc-abc', snapshotName: 'snapshot-123' });
  });
  it('parses a bare <volume>/<snapshot> without the scheme', () => {
    expect(parseSnapshotHandle('pvc-abc/snapshot-123'))
      .toEqual({ volumeName: 'pvc-abc', snapshotName: 'snapshot-123' });
  });
  it('rejects a handle with no snapshot segment', () => {
    expect(() => parseSnapshotHandle('snap://pvc-abc')).toThrow(RevertError);
    expect(() => parseSnapshotHandle('snap://pvc-abc/')).toThrow(/snap:\/\/<volume>\/<snapshot>/);
  });
});

describe('assertSnapshotRevertable', () => {
  it('passes for a ready snapshot that owns the volume on a healthy volume', async () => {
    const k8s = makeK8s({
      snapshot: { spec: { volume: 'vol-1' }, status: { readyToUse: true } },
      volume: { status: { robustness: 'healthy' } },
    });
    await expect(assertSnapshotRevertable(k8s, 'vol-1', 'snapshot-1')).resolves.toBeUndefined();
  });

  it('throws 404 when the snapshot is missing', async () => {
    const k8s = makeK8s({ snapshot: () => { throw Object.assign(new Error('nf'), { code: 404 }); } });
    await expect(assertSnapshotRevertable(k8s, 'vol-1', 'gone'))
      .rejects.toMatchObject({ code: 404 });
  });

  it('throws 409 when the snapshot belongs to a different volume', async () => {
    const k8s = makeK8s({ snapshot: { spec: { volume: 'other-vol' }, status: { readyToUse: true } } });
    await expect(assertSnapshotRevertable(k8s, 'vol-1', 'snapshot-1'))
      .rejects.toMatchObject({ code: 409 });
  });

  it('throws 409 when the snapshot never becomes ready', async () => {
    const k8s = makeK8s({ snapshot: { spec: { volume: 'vol-1' }, status: { readyToUse: false } } });
    await expect(assertSnapshotRevertable(k8s, 'vol-1', 'snapshot-1', { readinessTimeoutMs: 10 }))
      .rejects.toMatchObject({ code: 409 });
  });

  it('throws 409 when the volume is faulted', async () => {
    const k8s = makeK8s({
      snapshot: { spec: { volume: 'vol-1' }, status: { readyToUse: true } },
      volume: { status: { robustness: 'faulted' } },
    });
    await expect(assertSnapshotRevertable(k8s, 'vol-1', 'snapshot-1'))
      .rejects.toMatchObject({ code: 409 });
  });
});

describe('revertVolumeToSnapshot', () => {
  it('drives detach → maintenance-attach → snapshotRevert → detach and POSTs the right actions', async () => {
    const k8s = makeK8s({
      volumeScript: [
        { status: { state: 'detached' } },                                 // pollVolumeState(detached)
        { status: { ownerID: 'node-a' } },                                 // ownerID lookup
        { status: { state: 'attached', frontendDisabled: true } },         // wait-maintenance
      ],
      volumeAttachment: { spec: { attachmentTickets: {} } },
    });
    const fetchFn = okFetch();
    const steps = await revertVolumeToSnapshot(k8s, 'vol-1', 'snapshot-1', {
      apiBase: 'http://lh.test:9500', fetchFn: fetchFn as unknown as typeof fetch,
    });
    const labels = steps.map((s) => s.step);
    expect(labels).toEqual(['wait-detach', 'attach-maintenance', 'wait-maintenance', 'longhorn-revert', 'detach-maintenance']);
    expect(steps.every((s) => s.ok)).toBe(true);

    const urls = fetchFn.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain('/v1/volumes/vol-1?action=attach');
    expect(urls[1]).toContain('/v1/volumes/vol-1?action=snapshotRevert');
    expect(urls[2]).toContain('/v1/volumes/vol-1?action=detach');
    // maintenance-attach must disable the frontend; revert must name the snapshot
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toMatchObject({ hostId: 'node-a', disableFrontend: true });
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toEqual({ name: 'snapshot-1' });
  });

  it('throws 504 (and never reverts) when the volume will not detach', async () => {
    const k8s = makeK8s({
      volume: { status: { state: 'attached' } },
      volumeAttachment: { spec: { attachmentTickets: { 'csi-x': { type: 'csi-attacher' } } } },
    });
    const fetchFn = okFetch();
    await expect(revertVolumeToSnapshot(k8s, 'vol-1', 'snapshot-1', {
      fetchFn: fetchFn as unknown as typeof fetch, detachTimeoutMs: 30,
    })).rejects.toMatchObject({ code: 504 });
    expect(fetchFn).not.toHaveBeenCalled(); // we never attempted any Longhorn action
  });

  it('surfaces a non-2xx snapshotRevert as a 502 with the partial trace', async () => {
    const k8s = makeK8s({
      volumeScript: [
        { status: { state: 'detached' } },
        { status: { ownerID: 'node-a' } },
        { status: { state: 'attached', frontendDisabled: true } },
      ],
    });
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('action=snapshotRevert')) return { ok: false, status: 500, text: async () => 'engine busy' } as unknown as Response;
      return { ok: true, status: 200, text: async () => '' } as unknown as Response;
    });
    const err = await revertVolumeToSnapshot(k8s, 'vol-1', 'snapshot-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RevertError);
    expect((err as RevertError).code).toBe(502);
    expect((err as RevertError).steps.map((s) => s.step)).toContain('attach-maintenance');
  });
});

describe('resolveLonghornSnapshotFromCsi', () => {
  it('maps a VolumeSnapshot → content → handle → {volume, snapshot}', async () => {
    const k8s = makeK8s({
      volumeSnapshot: { status: { boundVolumeSnapshotContentName: 'snapcontent-9' } },
      volumeSnapshotContent: { status: { snapshotHandle: 'snap://pvc-xyz/snapshot-777' } },
    });
    await expect(resolveLonghornSnapshotFromCsi(k8s, 'tenant-ns', 'vs-1'))
      .resolves.toEqual({ volumeName: 'pvc-xyz', snapshotName: 'snapshot-777' });
  });

  it('throws 404 when the VolumeSnapshot is missing', async () => {
    const k8s = makeK8s({ volumeSnapshot: () => { throw Object.assign(new Error('nf'), { code: 404 }); } });
    await expect(resolveLonghornSnapshotFromCsi(k8s, 'tenant-ns', 'gone'))
      .rejects.toMatchObject({ code: 404 });
  });

  it('throws 409 when the snapshot has no bound content yet', async () => {
    const k8s = makeK8s({ volumeSnapshot: { status: {} } });
    await expect(resolveLonghornSnapshotFromCsi(k8s, 'tenant-ns', 'vs-1'))
      .rejects.toMatchObject({ code: 409 });
  });

  it('throws 409 when the bound content has no snapshotHandle yet', async () => {
    const k8s = makeK8s({
      volumeSnapshot: { status: { boundVolumeSnapshotContentName: 'snapcontent-9' } },
      volumeSnapshotContent: { status: {} },
    });
    await expect(resolveLonghornSnapshotFromCsi(k8s, 'tenant-ns', 'vs-1'))
      .rejects.toMatchObject({ code: 409 });
  });
});
