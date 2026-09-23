import { describe, it, expect } from 'vitest';
import { buildVolumeAlert, buildOrphanedVolumeAlert, type TenantRef } from './cluster-alerts.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Two operator complaints, both about a volume alert that could not be acted
 * on:
 *
 *   "VOLUME NEARLY FULL without mentioning the tenant name affected" — the
 *   subtitle carried `pvc-3f1a…`, which identifies nothing a human owns.
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

const bound = (over: Record<string, unknown> = {}) => ({
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
    ...over,
  },
});

describe('volume-nearly-full alert', () => {
  it('names the TENANT, not the Longhorn volume id', async () => {
    const a = await buildVolumeAlert(k8sWith([bound()]), tenants);
    expect(a).not.toBeNull();
    expect(a!.subtitle).toContain('Acme Trading');
    expect(a!.subtitle).not.toContain('pvc-0deda965');
    expect(a!.detail?.[0][0]).toBe('Acme Trading');
  });

  it('links to the tenant when exactly one is responsible', async () => {
    // /cluster/storage lists volumes but says nothing about who owns one.
    const a = await buildVolumeAlert(k8sWith([bound()]), tenants);
    expect(a!.href).toBe('/tenants/ten_acme');
  });

  it('falls back to cluster storage when several tenants are affected', async () => {
    const other = {
      ...bound(),
      metadata: { name: 'pvc-aaaa' },
      status: {
        ...bound().status,
        kubernetesStatus: { pvcName: 'x-storage', namespace: 'tenant-other-9', pvStatus: 'Bound', lastPVCRefAt: '' },
      },
    };
    const map = new Map(tenants);
    map.set('tenant-other-9', { id: 'ten_other', name: 'Other Ltd' });
    const a = await buildVolumeAlert(k8sWith([bound(), other]), map);
    expect(a!.href).toBe('/cluster/storage');
  });

  it('falls back to the PVC name when the namespace is not a tenant', async () => {
    const infra = {
      ...bound(),
      status: {
        ...bound().status,
        kubernetesStatus: { pvcName: 'system-db-1', namespace: 'platform', pvStatus: 'Bound', lastPVCRefAt: '' },
      },
    };
    const a = await buildVolumeAlert(k8sWith([infra]), tenants);
    expect(a!.subtitle).toContain('system-db-1');
    expect(a!.href).toBe('/cluster/storage');
  });

  it('ignores a detached volume reporting 0/0 rather than dividing by zero', async () => {
    const idle = { metadata: { name: 'pvc-idle' }, spec: { size: '0' }, status: { actualSize: '0' } };
    expect(await buildVolumeAlert(k8sWith([idle]), tenants)).toBeNull();
  });
});

describe('orphaned-volume alert', () => {
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
