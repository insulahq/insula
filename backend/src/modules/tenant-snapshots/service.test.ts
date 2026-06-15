import { describe, it, expect } from 'vitest';
import { buildVolumeSnapshotManifest, __test } from './service.js';

describe('buildVolumeSnapshotManifest', () => {
  const m = buildVolumeSnapshotManifest({
    namespace: 'tenant-abc',
    vsName: 'tvs-123',
    pvcName: 'tenant-abc-storage',
    tenantId: 'abc',
    snapshotId: 'snap-1',
  }) as {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string; labels: Record<string, string> };
    spec: { volumeSnapshotClassName: string; source: { persistentVolumeClaimName: string } };
  };

  it('targets the source PVC with the on-server (type=snap) longhorn class', () => {
    // `longhorn` class = Longhorn type=snap → in-cluster snapshot, NO off-site
    // upload. If this ever regresses to a `type=bak` class, tenant snapshots
    // would silently start consuming the off-site BackupTarget.
    expect(m.spec.volumeSnapshotClassName).toBe('longhorn');
    expect(m.spec.source.persistentVolumeClaimName).toBe('tenant-abc-storage');
    expect(m.kind).toBe('VolumeSnapshot');
    expect(m.apiVersion).toBe('snapshot.storage.k8s.io/v1');
  });

  it('labels the snapshot so the reaper + list path can find it', () => {
    expect(m.metadata.labels['insula.host/tenant-snapshot']).toBe('true');
    expect(m.metadata.labels['insula.host/tenant-id']).toBe('abc');
    expect(m.metadata.labels['insula.host/snapshot-id']).toBe('snap-1');
  });
});

describe('parseQuantityToBytes', () => {
  const p = __test.parseQuantityToBytes;
  it('parses binary + decimal suffixes', () => {
    expect(p('10Gi')).toBe(10 * 1024 ** 3);
    expect(p('512Mi')).toBe(512 * 1024 ** 2);
    expect(p('1000')).toBe(1000);
    expect(p('2G')).toBe(2_000_000_000);
  });
  it('is null-safe', () => {
    expect(p(undefined)).toBe(0);
    expect(p('')).toBe(0);
    expect(p('garbage')).toBe(0);
  });
});
