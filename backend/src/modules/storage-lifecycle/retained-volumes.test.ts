import { describe, it, expect } from 'vitest';
import { classifyRetainedVolumes } from './retained-volumes.js';

const NS = 'tenant-acme-1234';

function pv(name: string, opts: {
  phase?: string;
  ns?: string | null;
  storage?: string;
  released?: string;
} = {}) {
  return {
    metadata: { name },
    spec: {
      claimRef: opts.ns === null ? undefined : { namespace: opts.ns ?? NS },
      capacity: { storage: opts.storage ?? '30Gi' },
      storageClassName: 'longhorn-tenant',
    },
    status: { phase: opts.phase ?? 'Released', lastPhaseTransitionTime: opts.released ?? '2026-06-16T10:00:00Z' },
  };
}

function lhVol(name: string, pvName: string, size = '32212254720') {
  return { metadata: { name }, spec: { size }, status: { kubernetesStatus: { pvName } } };
}

/**
 * A snapshot fixture. `userCreated` defaults to TRUE because every existing
 * case here means "a person took a snapshot before a destructive op" — that
 * is what makes a volume a restorable fallback. Pass `userCreated: false` for
 * the snapshots Longhorn writes on its own behalf.
 */
function snap(
  name: string,
  volume: string,
  opts: { created?: string; size?: string; ready?: boolean; userCreated?: boolean } = {},
) {
  // The shape Longhorn v1.12 gives a snapshot: who asked for it is in the
  // STATUS. (This fixture once had it in the spec, like the code it tested —
  // and agreed with that code about a field no real snapshot has.)
  return {
    metadata: { name },
    spec: { volume, createSnapshot: true },
    status: {
      userCreated: opts.userCreated ?? true,
      readyToUse: opts.ready ?? true,
      size: opts.size ?? '1048576',
      creationTime: opts.created ?? '2026-06-16T09:00:00Z',
    },
  };
}

describe('classifyRetainedVolumes', () => {
  it('returns a Released PV in this namespace that has a snapshot', () => {
    const out = classifyRetainedVolumes({
      namespace: NS,
      boundVolumeName: 'pvc-new-bound',
      pvs: [pv('pvc-old')],
      longhornVolumes: [lhVol('pvc-old', 'pvc-old')],
      snapshots: [snap('snapshot-aaa', 'pvc-old', { created: '2026-06-16T09:00:00Z' })],
    });
    expect(out).toHaveLength(1);
    expect(out[0].pvName).toBe('pvc-old');
    expect(out[0].longhornVolumeName).toBe('pvc-old');
    expect(out[0].sizeBytes).toBe(30 * 1024 ** 3);
    // The release time is the PV's lastPhaseTransitionTime — it read a field PVs do not have and was always null.
    expect(out[0].releasedAt).toBe('2026-06-16T10:00:00.000Z');
    expect(out[0].snapshots).toHaveLength(1);
    expect(out[0].snapshots[0].name).toBe('snapshot-aaa');
    expect(out[0].snapshots[0].sizeBytes).toBe(1048576);
    expect(out[0].snapshots[0].readyToUse).toBe(true);
  });

  it('excludes the currently-bound volume (that is the in-place revert path)', () => {
    const out = classifyRetainedVolumes({
      namespace: NS,
      boundVolumeName: 'pvc-old',
      pvs: [pv('pvc-old')],
      longhornVolumes: [lhVol('pvc-old', 'pvc-old')],
      snapshots: [snap('snapshot-aaa', 'pvc-old')],
    });
    expect(out).toHaveLength(0);
  });

  it('excludes Released PVs from other namespaces (security)', () => {
    const out = classifyRetainedVolumes({
      namespace: NS,
      boundVolumeName: null,
      pvs: [pv('pvc-other', { ns: 'tenant-evil-9999' })],
      longhornVolumes: [lhVol('pvc-other', 'pvc-other')],
      snapshots: [snap('snapshot-x', 'pvc-other')],
    });
    expect(out).toHaveLength(0);
  });

  it('excludes Bound (still-live) PVs — only Released volumes are retained', () => {
    const out = classifyRetainedVolumes({
      namespace: NS,
      boundVolumeName: null,
      pvs: [pv('pvc-live', { phase: 'Bound' })],
      longhornVolumes: [lhVol('pvc-live', 'pvc-live')],
      snapshots: [snap('snapshot-x', 'pvc-live')],
    });
    expect(out).toHaveLength(0);
  });

  it('excludes retained volumes with no restorable snapshot (Q5)', () => {
    const out = classifyRetainedVolumes({
      namespace: NS,
      boundVolumeName: null,
      pvs: [pv('pvc-old')],
      longhornVolumes: [lhVol('pvc-old', 'pvc-old')],
      snapshots: [], // none
    });
    expect(out).toHaveLength(0);
  });

  it('ignores the volume-head pseudo-snapshot', () => {
    const out = classifyRetainedVolumes({
      namespace: NS,
      boundVolumeName: null,
      pvs: [pv('pvc-old')],
      longhornVolumes: [lhVol('pvc-old', 'pvc-old')],
      snapshots: [snap('volume-head', 'pvc-old')],
    });
    expect(out).toHaveLength(0);
  });

  it("does NOT offer a restore onto Longhorn's own expansion marker", () => {
    // Production: a tenant volume was expanded to 256 GiB and replaced 14
    // minutes later. Its only snapshot was `expand-274877906944`, written by
    // Longhorn on the expansion with `userCreated: false`.
    //
    // Counting that as a restore point made this card offer to roll the
    // tenant back onto it — onto a marker recording that a resize happened,
    // not a state anyone chose to keep. It also kept the volume out of orphan
    // detection, so 256 GiB sat unnoticed holding most of the cluster's
    // storage commitment.
    const out = classifyRetainedVolumes({
      namespace: 'tenant-x',
      boundVolumeName: 'pvc-live',
      pvs: [pv('pvc-old', 'tenant-x', { phase: 'Released' })],
      longhornVolumes: [lhVol('pvc-old', 'pvc-old')],
      snapshots: [snap('expand-274877906944', 'pvc-old', { userCreated: false })],
    });
    expect(out).toHaveLength(0);
  });

  // The objects below have the fields a cluster running Longhorn v1.12
  // returns, copied from one: `userCreated` is in the status, and the spec has
  // no such field. The fixtures above were once shaped like the code instead,
  // and both agreed on `spec.userCreated` — which made every retained volume
  // invisible on a real cluster while this file stayed green.
  describe('snapshots as a real cluster returns them', () => {
    const status = (userCreated: boolean, labels: Record<string, string>) => ({
      checksum: '', children: { 'volume-head': true }, creationTime: '2026-10-13T10:57:02Z', labels, markRemoved: false,
      ownerID: 'node-a', parent: '', readyToUse: true, requestedTime: '2026-10-13T10:57:02Z', restoreSize: 2147483648, size: 53133312, userCreated,
    });
    const taken = { metadata: { name: 'snapshot-68f25756', labels: { longhornvolume: 'pvc-old' } }, spec: { createSnapshot: true, labels: { type: 'snap' }, volume: 'pvc-old' }, status: status(true, { type: 'snap' }) };
    const marker = { metadata: { name: 'expand-3221225472', labels: { longhornvolume: 'pvc-old' } }, spec: { createSnapshot: true, labels: null, volume: 'pvc-old' }, status: status(false, { 'replica-expansion': '3221225472' }) };
    const classify = (snapshots: unknown[]) => classifyRetainedVolumes({
      namespace: NS, boundVolumeName: 'pvc-new-bound', pvs: [pv('pvc-old')], longhornVolumes: [lhVol('pvc-old', 'pvc-old')], snapshots: snapshots as never,
    });

    it('a snapshot a person took makes its volume a retained one, with that snapshot to restore from', () => {
      const out = classify([taken, marker]);
      expect(out).toHaveLength(1);
      expect(out[0].snapshots.map((x) => x.name)).toEqual(['snapshot-68f25756']);
      expect(out[0].snapshots[0]).toMatchObject({ readyToUse: true, sizeBytes: 53133312, createdAt: '2026-10-13T10:57:02Z' });
    });

    it('a volume with only Longhorn\'s expansion marker is not one', () => {
      expect(classify([marker])).toEqual([]);
    });

    // Longhorn flags a recurring job's snapshots as user-created too. Nothing
    // rotates them on a volume that has been released — the job only runs on
    // an attached one — so counting them would keep the volume "retained" for good.
    const scheduled = { metadata: { name: 'hourly-snap-a1b2c3', labels: { longhornvolume: 'pvc-old' } }, spec: { createSnapshot: true, labels: { RecurringJob: 'hourly-snap' }, volume: 'pvc-old' }, status: status(true, { RecurringJob: 'hourly-snap' }) };

    it('a volume with only a schedule\'s snapshots is not one either, although Longhorn flags those as user-created', () => {
      expect(classify([scheduled, marker])).toEqual([]);
    });

    it('…and beside a snapshot a person took, the schedule\'s are not offered as restore points', () => {
      expect(classify([scheduled, taken])[0].snapshots.map((x) => x.name)).toEqual(['snapshot-68f25756']);
    });

    it('the schedule\'s label counts wherever Longhorn has put it', () => {
      expect(classify([{ ...scheduled, spec: { ...scheduled.spec, labels: null } }])).toEqual([]);
      expect(classify([{ ...scheduled, status: status(true, {}) }])).toEqual([]);
    });

    it('a flag in the spec — where no snapshot has one — counts for nothing', () => {
      expect(classify([{ ...taken, spec: { ...taken.spec, userCreated: true }, status: { ...taken.status, userCreated: undefined } }])).toEqual([]);
    });
  });

  it('sorts snapshots newest-first within a volume', () => {
    const out = classifyRetainedVolumes({
      namespace: NS,
      boundVolumeName: null,
      pvs: [pv('pvc-old')],
      longhornVolumes: [lhVol('pvc-old', 'pvc-old')],
      snapshots: [
        snap('snapshot-old', 'pvc-old', { created: '2026-06-10T00:00:00Z' }),
        snap('snapshot-new', 'pvc-old', { created: '2026-06-16T00:00:00Z' }),
      ],
    });
    expect(out[0].snapshots.map((s) => s.name)).toEqual(['snapshot-new', 'snapshot-old']);
  });

  it('sorts volumes by newest snapshot first', () => {
    const out = classifyRetainedVolumes({
      namespace: NS,
      boundVolumeName: null,
      pvs: [pv('pvc-a'), pv('pvc-b')],
      longhornVolumes: [lhVol('pvc-a', 'pvc-a'), lhVol('pvc-b', 'pvc-b')],
      snapshots: [
        snap('snapshot-a', 'pvc-a', { created: '2026-06-10T00:00:00Z' }),
        snap('snapshot-b', 'pvc-b', { created: '2026-06-16T00:00:00Z' }),
      ],
    });
    expect(out.map((v) => v.pvName)).toEqual(['pvc-b', 'pvc-a']);
  });

  it('tolerates a numeric Longhorn snapshot size (real cluster returns int64, not a string)', () => {
    // Regression for the live 500: Longhorn `snapshots.longhorn.io` status.size
    // is a JSON number, and the old parser called value.match() on it.
    const out = classifyRetainedVolumes({
      namespace: NS,
      boundVolumeName: null,
      pvs: [pv('pvc-old')],
      longhornVolumes: [{ metadata: { name: 'pvc-old' }, spec: { size: 2147483648 }, status: { kubernetesStatus: { pvName: 'pvc-old' } } } as never],
      snapshots: [{ metadata: { name: 'snapshot-num' }, spec: { volume: 'pvc-old' }, status: { userCreated: true, readyToUse: true, size: 1048576, creationTime: '2026-06-16T09:00:00Z' } } as never],
    });
    expect(out).toHaveLength(1);
    expect(out[0].snapshots[0].sizeBytes).toBe(1048576);
  });

  it('falls back to the Longhorn volume size when the PV capacity is missing', () => {
    const out = classifyRetainedVolumes({
      namespace: NS,
      boundVolumeName: null,
      pvs: [{ metadata: { name: 'pvc-old' }, spec: { claimRef: { namespace: NS } }, status: { phase: 'Released' } }],
      longhornVolumes: [lhVol('pvc-old', 'pvc-old', '21474836480')],
      snapshots: [snap('snapshot-aaa', 'pvc-old')],
    });
    expect(out[0].sizeBytes).toBe(21474836480);
  });
});
