import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const { autoTarget } = vi.hoisted(() => ({ autoTarget: vi.fn() }));
vi.mock('./auto-target.js', () => ({ resolveAutoTarget: autoTarget }));

import { repinTenantPlacement } from './service.js';

/**
 * A re-pin to Auto and the tenant's pods. Production: a drain cleared an Auto
 * tenant's hostname selector, the scheduler placed its web pods with the
 * ReadWriteOnce volume and its database on another node, and the database
 * never started. Auto now sends a Local-tier tenant's pods to ONE node.
 */
/** `live` = the namespace's Deployments as the cluster lists them. */
function fakeCluster(live: unknown[] = []) {
  const deployments: Array<{ name: string; body: unknown }> = [];
  const volumes: Array<{ name: string; body: unknown }> = [];
  const rows: unknown[] = [];
  const k8s = {
    core: { readNode: async () => ({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }) },
    apps: {
      patchNamespacedDeployment: async ({ name, body }: { name: string; body: unknown }) => {
        deployments.push({ name, body });
        return {};
      },
      listNamespacedDeployment: async () => ({ items: live }),
      readNamespacedDeployment: async ({ name }: { name: string }) => ({
        spec: { template: { spec: (live as Array<{ metadata: { name: string }; spec: { template: { spec: unknown } } }>)
          .find((d) => d.metadata.name === name)?.spec.template.spec } },
      }),
    },
    custom: {
      patchNamespacedCustomObject: async ({ name, body }: { name: string; body: unknown }) => {
        volumes.push({ name, body });
        return {};
      },
    },
  } as unknown as K8sClients;
  const db = {
    update: () => ({ set: (row: unknown) => { rows.push(row); return { where: async () => undefined }; } }),
  } as unknown as Database;
  return { k8s, db, deployments, volumes, rows };
}

const TENANT = {
  tenantId: 't1',
  namespace: 'tenant-acme',
  workloads: [
    { kind: 'Deployment' as const, name: 'website', pinKind: 'nodeSelector' as const },
    { kind: 'Deployment' as const, name: 'my-mariadb', pinKind: 'nodeSelector' as const },
  ],
  pvcs: [{ volumeName: 'pvc-1' }],
  storageTier: 'local',
};
const tag = async (t: string) => `node-${t}`;
const selectorOf = (body: unknown) =>
  (body as { spec: { template: { spec: { nodeSelector: Record<string, string | null> } } } }).spec.template.spec.nodeSelector;

beforeEach(() => { autoTarget.mockReset(); });

describe('repinTenantPlacement to Auto', () => {
  it('sends every workload and the file manager to the one node, and leaves the tenant on Auto', async () => {
    autoTarget.mockResolvedValue({ node: 'sv3', source: 'replica' });
    const c = fakeCluster();
    const counts = await repinTenantPlacement(c.k8s, c.db, TENANT, '', 'sv2', tag);

    expect(autoTarget).toHaveBeenCalledWith(c.k8s, c.db, {
      namespace: 'tenant-acme', volumeNames: ['pvc-1'], releaseFrom: 'sv2', storageTier: 'local',
    });
    expect(c.deployments.map((d) => [d.name, selectorOf(d.body)['kubernetes.io/hostname']])).toEqual([
      ['website', 'sv3'], ['my-mariadb', 'sv3'], ['file-manager', 'sv3'],
    ]);
    // Auto: no volume node tag, no primary node.
    expect(c.volumes).toEqual([{ name: 'pvc-1', body: { spec: { nodeSelector: [] } } }]);
    expect(c.rows[0]).toMatchObject({ nodeName: null });
    expect(counts.autoNode).toBe('sv3');
  });

  it('takes along a workload that shares the volume but was not pinned to the node being left', async () => {
    autoTarget.mockResolvedValue({ node: 'sv3', source: 'replica' });
    const mounts = { volumes: [{ persistentVolumeClaim: { claimName: 'tenant-acme-storage' } }] };
    const c = fakeCluster([
      { metadata: { name: 'website' }, spec: { template: { spec: { nodeSelector: { 'kubernetes.io/hostname': 'sv2' }, ...mounts } } } },
      { metadata: { name: 'crm' }, spec: { template: { spec: { ...mounts } } } },
      { metadata: { name: 'proxy' }, spec: { template: { spec: {} } } },
      { metadata: { name: 'cron' }, spec: { template: { spec: { nodeSelector: { 'kubernetes.io/hostname': 'sv1' }, ...mounts } } } },
    ]);
    const counts = await repinTenantPlacement(c.k8s, c.db, { ...TENANT, workloads: [TENANT.workloads[0]!] }, '', 'sv2', tag);
    // crm shares the volume and carries no pin; proxy mounts nothing; cron is pinned elsewhere.
    expect(c.deployments.map((d) => d.name)).toEqual(['website', 'file-manager', 'crm']);
    expect(selectorOf(c.deployments[2]!.body)['kubernetes.io/hostname']).toBe('sv3');
    expect(counts.workloads).toBe(2);
  });

  it('strips a nodeAffinity pin on the node being left and pins to the one node', async () => {
    autoTarget.mockResolvedValue({ node: 'sv3', source: 'replica' });
    const c = fakeCluster([{
      metadata: { name: 'db' },
      spec: { template: { spec: { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['sv2'] }] }],
      } } } } } },
    }]);
    await repinTenantPlacement(c.k8s, c.db, {
      ...TENANT, workloads: [{ kind: 'Deployment' as const, name: 'db', pinKind: 'nodeAffinity' as const }],
    }, '', 'sv2', tag);
    expect(c.deployments[0]).toEqual({
      name: 'db',
      body: { spec: { template: { spec: { affinity: null, nodeSelector: { 'kubernetes.io/hostname': 'sv3' } } } } },
    });
  });

  it('clears the pin as before when no node can be found', async () => {
    autoTarget.mockResolvedValue({ node: null, source: null });
    const c = fakeCluster();
    const counts = await repinTenantPlacement(c.k8s, c.db, TENANT, '', 'sv2', tag);
    expect(c.deployments.every((d) => selectorOf(d.body)['kubernetes.io/hostname'] === null)).toBe(true);
    expect(counts.autoNode).toBeNull();
  });

  it('holds an HA tenant, or one of unknown tier, to no node, and a named target is used as it is', async () => {
    for (const storageTier of ['ha', undefined]) {
      const c = fakeCluster();
      await repinTenantPlacement(c.k8s, c.db, { ...TENANT, storageTier }, '', 'sv2', tag);
      expect(c.deployments.every((d) => selectorOf(d.body)['kubernetes.io/hostname'] === null)).toBe(true);
    }
    expect(autoTarget).not.toHaveBeenCalled();

    const named = fakeCluster();
    await repinTenantPlacement(named.k8s, named.db, TENANT, 'sv4', 'sv2', tag);
    expect(autoTarget).not.toHaveBeenCalled();
    expect(named.deployments.every((d) => selectorOf(d.body)['kubernetes.io/hostname'] === 'sv4')).toBe(true);
  });
});
