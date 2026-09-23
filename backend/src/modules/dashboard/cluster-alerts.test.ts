import { describe, it, expect } from 'vitest';
import { buildVolumeAlert, buildOrphanedVolumeAlert, type TenantRef } from './cluster-alerts.js';
import type { PvcUsage, PvcUsageReader } from './pvc-usage.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Three operator complaints, all about a volume alert that could not be acted
 * on:
 *
 *   "VOLUME NEARLY FULL without mentioning the tenant name affected" — the
 *   subtitle carried `pvc-3f1a…`, which identifies nothing a human owns.
 *
 *   "why is platform-db reported almost full" — it was not. The alert divided
 *   Longhorn's `actualSize` (the host cost of the whole snapshot chain) by the
 *   volume's capacity and got 93 %, while `df` inside the pod said 36 %. It now
 *   reads the filesystem, so the number it prints is the one that decides
 *   whether the workload can write.
 *
 *   "there is an orphaned volume in production, but no orphaned volume card" —
 *   a Longhorn volume whose PVC went away weeks ago, holding its full
 *   allocation on disk and invisible in `kubectl get pvc`, on the tenant's
 *   usage page and on the cluster storage list alike.
 *
 * The orphan's signature here is the one a real cluster produces: `pvStatus`
 * no longer `Bound` with `lastPVCRefAt` set.
 */

const GiB = 1073741824;

function k8sWith(items: unknown[]): K8sClients {
  return {
    custom: { listNamespacedCustomObject: async () => ({ items }) },
  } as unknown as K8sClients;
}

const tenants = new Map<string, TenantRef>([
  ['tenant-acme-1234', { id: 'ten_acme', name: 'Acme Trading' }],
]);

/**
 * Longhorn is NOT consulted for fullness any more, so these fixtures are what
 * the kubelet reports: a filesystem, its capacity, and how much of it is gone.
 */
const usage = (over: Partial<PvcUsage> = {}): PvcUsage => ({
  namespace: 'tenant-acme-1234',
  pvcName: 'tenant-acme-1234-storage',
  usedBytes: 9.5 * GiB,
  capacityBytes: 10 * GiB,
  fraction: 0.95,
  ...over,
});

const reader = (items: readonly PvcUsage[]): PvcUsageReader => async () => items;

/**
 * A client that answers nothing. The fullness alert must not need it: if it
 * ever reaches for the Longhorn CRs again this throws, which is the whole
 * point — `actualSize` is how the alert got the wrong answer in the first
 * place, and a passing test is the only thing that keeps it out.
 */
const noCluster = {
  custom: {
    listNamespacedCustomObject: async () => { throw new Error('Longhorn must not be consulted for fullness'); },
  },
  core: {
    listNode: async () => { throw new Error('reader was not injected'); },
  },
} as unknown as K8sClients;

describe('volume-nearly-full alert', () => {
  it('names the TENANT, not the Longhorn volume id', async () => {
    const a = await buildVolumeAlert(noCluster, tenants, reader([usage()]));
    expect(a).not.toBeNull();
    expect(a!.subtitle).toContain('Acme Trading');
    expect(a!.subtitle).not.toContain('pvc-0deda965');
    expect(a!.detail?.[0][0]).toBe('Acme Trading');
  });

  it('links to the tenant when exactly one is responsible', async () => {
    // /cluster/storage lists volumes but says nothing about who owns one.
    const a = await buildVolumeAlert(noCluster, tenants, reader([usage()]));
    expect(a!.href).toBe('/tenants/ten_acme');
  });

  it('falls back to cluster storage when several tenants are affected', async () => {
    const map = new Map(tenants);
    map.set('tenant-other-9', { id: 'ten_other', name: 'Other Ltd' });
    const a = await buildVolumeAlert(noCluster, map, reader([
      usage(),
      usage({ namespace: 'tenant-other-9', pvcName: 'x-storage' }),
    ]));
    expect(a!.href).toBe('/cluster/storage');
  });

  it('falls back to the PVC name when the namespace is not a tenant', async () => {
    const a = await buildVolumeAlert(noCluster, tenants, reader([
      usage({ namespace: 'platform', pvcName: 'system-db-1' }),
    ]));
    expect(a!.subtitle).toContain('system-db-1');
    expect(a!.href).toBe('/cluster/storage');
  });

  it('stays silent on the production platform database that triggered this', async () => {
    // The real numbers: 1945 MiB of ext4 on a 2 GiB Longhorn volume, 701 MiB
    // used. Longhorn called the same volume 1.86 of 2 GiB — 93 %, a warning —
    // because six hourly snapshots of a WAL-rewriting database held 1.8 GiB of
    // chain behind it.
    const a = await buildVolumeAlert(noCluster, tenants, reader([{
      namespace: 'platform',
      pvcName: 'system-db-1',
      usedBytes: 701 * 1048576,
      capacityBytes: 1945 * 1048576,
      fraction: (701 * 1048576) / (1945 * 1048576),
    }]));
    expect(a).toBeNull();
  });

  it('escalates to critical past 95 %', async () => {
    const a = await buildVolumeAlert(noCluster, tenants, reader([usage({ fraction: 0.97 })]));
    expect(a!.severity).toBe('critical');
  });

  it('reports nothing when no kubelet answered', async () => {
    // An empty reading is "unknown", and unknown must never render as an alert.
    expect(await buildVolumeAlert(noCluster, tenants, reader([]))).toBeNull();
  });
});

describe('orphaned-volume alert', () => {
  /** A healthy Longhorn volume — still the orphan alert's own input shape. */
  const bound = () => ({
    metadata: { name: 'pvc-0deda965-5a31-4a' },
    spec: { size: String(10 * GiB) },
    status: {
      actualSize: String(9.5 * GiB),
      kubernetesStatus: {
        pvcName: 'tenant-acme-1234-storage',
        namespace: 'tenant-acme-1234',
        pvStatus: 'Bound',
        lastPVCRefAt: '',
      },
    },
  });

  const orphan = {
    metadata: { name: 'pvc-f1dc333c-46d5-45' },
    spec: { size: String(20 * GiB) },
    status: {
      actualSize: String(4 * GiB),
      kubernetesStatus: {
        pvcName: 'tenant-acme-1234-storage',
        namespace: 'tenant-acme-1234',
        pvStatus: '',
        lastPVCRefAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
      },
    },
  };

  it('fires for a volume whose PVC is gone', async () => {
    const a = await buildOrphanedVolumeAlert(k8sWith([orphan]), tenants);
    expect(a).not.toBeNull();
    expect(a!.title).toBe('Orphaned volume');
    expect(a!.subtitle).toContain('Acme Trading');
    expect(a!.subtitle).toMatch(/PVC gone 20d ago/);
    // The headline number is the disk that can be reclaimed, not a count.
    expect(a!.value).toBe('4 GiB');
  });

  it('does NOT fire for a healthy bound volume', async () => {
    expect(await buildOrphanedVolumeAlert(k8sWith([bound()]), tenants)).toBeNull();
  });

  it('does NOT fire for a volume still being provisioned', async () => {
    // Empty pvStatus but no lastPVCRefAt: a PVC was never bound, so nothing
    // has been orphaned. Requiring BOTH signals keeps this quiet.
    const provisioning = {
      metadata: { name: 'pvc-new' },
      spec: { size: String(GiB) },
      status: { actualSize: '0', kubernetesStatus: { pvStatus: '', lastPVCRefAt: '' } },
    };
    expect(await buildOrphanedVolumeAlert(k8sWith([provisioning]), tenants)).toBeNull();
  });

  it('sums reclaimable disk across several orphans, worst first', async () => {
    const smaller = {
      ...orphan,
      metadata: { name: 'pvc-small' },
      status: { ...orphan.status, actualSize: String(GiB) },
    };
    const a = await buildOrphanedVolumeAlert(k8sWith([smaller, orphan]), tenants);
    expect(a!.title).toBe('Orphaned volumes');
    expect(a!.value).toBe('5 GiB');
    expect(a!.detail?.[0][1]).toContain('4 GiB');
  });
});
