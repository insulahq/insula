import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * The integrity sweep and a storage volume that is absent on purpose.
 *
 * An archive deletes the tenant's volume after copying its files off-site.
 * Half an hour later this sweep found the volume "missing" and created an
 * empty one — for every archived tenant, with a notification each.
 */

const applyPVC = vi.fn(async () => undefined);
vi.mock('../k8s-provisioner/service.js', () => ({
  applyNamespace: vi.fn(),
  applyResourceQuota: vi.fn(),
  applyNetworkPolicy: vi.fn(),
  applyPVC: (...args: unknown[]) => applyPVC(...(args as [])),
}));

const { checkTenantNamespaceIntegrity, volumeExpected } = await import('./service.js');

const NS = 'tenant-acme';
const notFound = Object.assign(new Error('not found'), { code: 404 });

/** A namespace that has everything but (optionally) its storage volume. */
function cluster(volume: boolean): K8sClients {
  return {
    core: {
      readNamespace: async () => ({}),
      readNamespacedPersistentVolumeClaim: async () => {
        if (!volume) throw notFound;
        return { spec: { resources: { requests: { storage: '2Gi' } } } };
      },
      readNamespacedResourceQuota: async () => ({}),
      listNamespacedResourceQuota: async () => ({ items: [] }),
    },
    networking: { readNamespacedNetworkPolicy: async () => ({}) },
  } as unknown as K8sClients;
}

function database(tenant: Record<string, unknown>): Database {
  const rows = [
    [{ id: 't1', name: 'Acme', kubernetesNamespace: NS, provisioningStatus: 'provisioned', planId: 'p1', storageLimitOverride: null, ...tenant }],
    [{ id: 'p1', storageLimit: '2', cpuLimit: '1', memoryLimit: '1' }],
  ];
  let call = 0;
  const chain = () => {
    const result = rows[Math.min(call, rows.length - 1)];
    call += 1;
    return {
      from: () => ({ where: () => ({ limit: async () => result, then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r) }) }),
    };
  };
  return {
    select: () => chain(),
    insert: () => ({ values: async () => undefined }),
  } as unknown as Database;
}

describe('a storage volume that is absent on purpose', () => {
  beforeEach(() => { applyPVC.mockClear(); });

  it('an archived tenant without a volume has nothing missing, and no volume is created for it', async () => {
    const report = await checkTenantNamespaceIntegrity(database({ status: 'archived', storageLifecycleState: 'idle' }), cluster(false), 't1', true);
    expect(report.findings).toEqual([]);
    expect(report.repaired).toEqual([]);
    expect(applyPVC).not.toHaveBeenCalled();
  });

  it.each(['replacing', 'restoring', 'resizing', 'archiving', 'quiescing', 'failed'])(
    'while a storage operation owns the tenant (%s) its volume is that operation\'s business', async (state) => {
      const report = await checkTenantNamespaceIntegrity(database({ status: 'active', storageLifecycleState: state }), cluster(false), 't1', true);
      expect(report.findings).toEqual([]);
      expect(applyPVC).not.toHaveBeenCalled();
    });

  it.each(['active', 'suspended'])('a %s tenant with nothing under way that lost its volume still gets it back', async (status) => {
    const report = await checkTenantNamespaceIntegrity(database({ status, storageLifecycleState: 'idle' }), cluster(false), 't1', true);
    expect(report.findings).toEqual(['pvc_missing']);
    expect(report.repaired).toEqual(['pvc_missing']);
    expect(applyPVC).toHaveBeenCalledTimes(1);
  });

  it('the audit alone (no repair) reports the same: nothing for an archived tenant, the volume for an active one', async () => {
    expect((await checkTenantNamespaceIntegrity(database({ status: 'archived', storageLifecycleState: 'idle' }), cluster(false), 't1', false)).findings).toEqual([]);
    expect((await checkTenantNamespaceIntegrity(database({ status: 'active', storageLifecycleState: 'idle' }), cluster(false), 't1', false)).findings).toEqual(['pvc_missing']);
    expect(applyPVC).not.toHaveBeenCalled();
  });

  it('a tenant that has its volume is not touched either way', async () => {
    for (const status of ['active', 'archived']) {
      const report = await checkTenantNamespaceIntegrity(database({ status, storageLifecycleState: 'idle' }), cluster(true), 't1', true);
      expect(report.findings).toEqual([]);
    }
    expect(applyPVC).not.toHaveBeenCalled();
  });

  it('volumeExpected: only an un-archived tenant with nothing under way', () => {
    expect(volumeExpected({ status: 'active', storageLifecycleState: 'idle' })).toBe(true);
    expect(volumeExpected({ status: 'suspended', storageLifecycleState: 'idle' })).toBe(true);
    expect(volumeExpected({ status: 'archived', storageLifecycleState: 'idle' })).toBe(false);
    expect(volumeExpected({ status: 'active', storageLifecycleState: 'failed' })).toBe(false);
  });
});
