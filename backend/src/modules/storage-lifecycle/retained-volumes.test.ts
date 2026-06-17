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
    status: { phase: opts.phase ?? 'Released', lastTransitionTime: opts.released ?? '2026-06-16T10:00:00Z' },
  };
}

function lhVol(name: string, pvName: string, size = '32212254720') {
  return { metadata: { name }, spec: { size }, status: { kubernetesStatus: { pvName } } };
}

function snap(name: string, volume: string, opts: { created?: string; size?: string; ready?: boolean } = {}) {
  return {
    metadata: { name },
    spec: { volume },
    status: {
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
