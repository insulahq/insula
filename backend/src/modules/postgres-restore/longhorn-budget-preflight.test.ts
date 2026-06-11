import { describe, it, expect, vi } from 'vitest';
import { checkLonghornBudgetForRecovery, parseQuantityBytes } from './longhorn-budget-preflight.js';

const GI = 2 ** 30;

function makeK8s(opts: {
  pvcCapacity?: string;
  pvDriver?: string;
  overProvisioningPct?: string;
  nodes?: Array<{
    reserved: number;
    max: number;
    scheduled: number;
    allowScheduling?: boolean;
  }>;
  releasedSystemPvs?: Array<{ name: string; size: string }>;
  pvcThrows?: boolean;
}) {
  const core = {
    readNamespacedPersistentVolumeClaim: vi.fn(async () => {
      if (opts.pvcThrows) throw new Error('apiserver unreachable');
      return {
        spec: { volumeName: 'pvc-abc' },
        status: { capacity: { storage: opts.pvcCapacity ?? '20Gi' } },
      };
    }),
    readPersistentVolume: vi.fn(async () => ({
      spec: { csi: { driver: opts.pvDriver ?? 'driver.longhorn.io' } },
    })),
    listPersistentVolume: vi.fn(async () => ({
      items: (opts.releasedSystemPvs ?? []).map((p) => ({
        metadata: { name: p.name },
        status: { phase: 'Released' },
        spec: { claimRef: { namespace: 'platform', name: 'system-db-1' }, capacity: { storage: p.size } },
      })),
    })),
  };
  const custom = {
    getNamespacedCustomObject: vi.fn(async () => ({ value: opts.overProvisioningPct ?? '100' })),
    listNamespacedCustomObject: vi.fn(async () => ({
      items: (opts.nodes ?? []).map((n, i) => ({
        metadata: { name: `node${i}` },
        spec: { disks: { d0: { storageReserved: n.reserved, allowScheduling: n.allowScheduling !== false } } },
        status: { diskStatus: { d0: { storageMaximum: n.max, storageScheduled: n.scheduled } } },
      })),
    })),
  };
  return { core, custom } as never;
}

describe('parseQuantityBytes', () => {
  it('parses binary suffixes and bare bytes', () => {
    expect(parseQuantityBytes('20Gi')).toBe(20 * GI);
    expect(parseQuantityBytes('512Mi')).toBe(512 * 2 ** 20);
    expect(parseQuantityBytes('1073741824')).toBe(GI);
    expect(parseQuantityBytes('1.5Gi')).toBe(Math.round(1.5 * GI));
  });
  it('rejects unparseable input', () => {
    expect(parseQuantityBytes('20G')).toBeNull(); // decimal SI not emitted by Longhorn/CNPG
    expect(parseQuantityBytes('')).toBeNull();
    expect(parseQuantityBytes(undefined)).toBeNull();
  });
});

describe('checkLonghornBudgetForRecovery', () => {
  const opts = { namespace: 'platform', pvcName: 'system-db-1' };

  it('ok when one disk has headroom for the recovery volume', async () => {
    // (80 − 24) × 100% − 21 = 35Gi headroom ≥ 20Gi needed.
    const k8s = makeK8s({ nodes: [{ max: 80 * GI, reserved: 24 * GI, scheduled: 21 * GI }] });
    const v = await checkLonghornBudgetForRecovery(k8s, opts);
    expect(v.state).toBe('ok');
    expect(v.bestDiskHeadroomBytes).toBe(35 * GI);
  });

  it('insufficient reproduces the live testing arithmetic and names reclaim candidates', async () => {
    // The 2026-06-11 shape: (80 − 24) × 100% − 44 = 12Gi < 20Gi.
    const k8s = makeK8s({
      nodes: [{ max: 80 * GI, reserved: 24 * GI, scheduled: 44 * GI }],
      releasedSystemPvs: [{ name: 'pvc-old-system-db', size: '20Gi' }],
    });
    const v = await checkLonghornBudgetForRecovery(k8s, opts);
    expect(v.state).toBe('insufficient');
    expect(v.detail).toContain('pvc-old-system-db');
    expect(v.detail).toContain('over-provisioning');
    expect(v.reclaimCandidates).toHaveLength(1);
  });

  it('over-provisioning percentage scales the budget', async () => {
    // Same disk as the insufficient case, but pct=200:
    // (80 − 24) × 200% − 44 = 68Gi ≥ 20Gi.
    const k8s = makeK8s({
      nodes: [{ max: 80 * GI, reserved: 24 * GI, scheduled: 44 * GI }],
      overProvisioningPct: '200',
    });
    const v = await checkLonghornBudgetForRecovery(k8s, opts);
    expect(v.state).toBe('ok');
  });

  it('skips non-Longhorn storage (local-path DinD)', async () => {
    const k8s = makeK8s({ pvDriver: 'rancher.io/local-path' });
    const v = await checkLonghornBudgetForRecovery(k8s, opts);
    expect(v.state).toBe('skipped');
  });

  it('skips disks with allowScheduling=false', async () => {
    const k8s = makeK8s({
      nodes: [
        { max: 500 * GI, reserved: 0, scheduled: 0, allowScheduling: false },
        { max: 80 * GI, reserved: 24 * GI, scheduled: 44 * GI },
      ],
    });
    const v = await checkLonghornBudgetForRecovery(k8s, opts);
    expect(v.state).toBe('insufficient'); // the big disk must not count
  });

  it('degrades to skip when cluster state is unreadable (guard rail, not failure mode)', async () => {
    const k8s = makeK8s({ pvcThrows: true });
    const v = await checkLonghornBudgetForRecovery(k8s, opts);
    expect(v.state).toBe('skipped');
    expect(v.detail).toContain('unreadable');
  });
});
