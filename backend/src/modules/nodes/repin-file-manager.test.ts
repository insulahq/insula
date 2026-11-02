import { describe, expect, it } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { repinTenantPlacement } from './service.js';

/**
 * A drain's re-pin and the tenant's file manager. The impact lists only
 * workloads carrying the old pin, and a file manager is placed where the data
 * is when it starts, so it often carries none. Left out, a running one held the
 * RWO volume on the old node and the re-pinned pods waited behind it (lab
 * staging: 8 minutes, until it idled).
 */
function fakeCluster(o: { fileManager?: boolean } = {}) {
  const patched: Array<{ name: string; body: unknown }> = [];
  const k8s = {
    core: {
      readNode: async () => ({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }),
    },
    apps: {
      patchNamespacedDeployment: async ({ name, body }: { name: string; body: unknown }) => {
        if (name === 'file-manager' && o.fileManager === false) {
          throw Object.assign(new Error('not found'), { code: 404 });
        }
        patched.push({ name, body });
        return {};
      },
    },
    custom: {
      patchNamespacedCustomObject: async () => ({}),
      listNamespacedCustomObject: async () => ({ items: [] }),
    },
  } as unknown as K8sClients;
  const db = { update: () => ({ set: () => ({ where: async () => undefined }) }) } as unknown as Database;
  return { k8s, db, patched };
}

const TENANT = {
  tenantId: 't1',
  namespace: 'tenant-acme',
  workloads: [{ kind: 'Deployment' as const, name: 'web', pinKind: 'nodeSelector' as const }],
  pvcs: [{ volumeName: 'pvc-1' }],
  storageTier: 'local',
};

describe('repinTenantPlacement and the file manager', () => {
  it('pins the file manager to the target with the tenant, though the impact did not list it', async () => {
    const { k8s, db, patched } = fakeCluster();
    await repinTenantPlacement(k8s, db, TENANT, 'node-b', 'node-a', async (t) => `node-${t}`);
    expect(patched.map((p) => p.name)).toEqual(['web', 'file-manager']);
    expect(patched[1]!.body).toEqual({ spec: { template: { spec: { nodeSelector: { 'kubernetes.io/hostname': 'node-b' } } } } });
  });

  it('takes its pin off for "auto" when no node can hold the pods together, and does not patch it twice when the impact listed it', async () => {
    const auto = fakeCluster();
    await repinTenantPlacement(auto.k8s, auto.db, TENANT, '', 'node-a', async (t) => `node-${t}`);
    expect(auto.patched[1]).toEqual({ name: 'file-manager', body: { spec: { template: { spec: { nodeSelector: { 'kubernetes.io/hostname': null } } } } } });

    const listed = fakeCluster();
    await repinTenantPlacement(listed.k8s, listed.db, {
      ...TENANT,
      workloads: [...TENANT.workloads, { kind: 'Deployment' as const, name: 'file-manager', pinKind: 'nodeSelector' as const }],
    }, 'node-b', 'node-a', async (t) => `node-${t}`);
    expect(listed.patched.filter((p) => p.name === 'file-manager')).toHaveLength(1);
  });

  it('is fine with a tenant that has no file manager', async () => {
    const { k8s, db, patched } = fakeCluster({ fileManager: false });
    const counts = await repinTenantPlacement(k8s, db, TENANT, 'node-b', 'node-a', async (t) => `node-${t}`);
    expect(patched.map((p) => p.name)).toEqual(['web']);
    expect(counts.workloads).toBe(1);
  });
});
