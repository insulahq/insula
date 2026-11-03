import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

vi.mock('../k8s-provisioner/service.js', () => ({ patchTenantVolumeReplicas: vi.fn().mockResolvedValue(undefined) }));

import { applyTenantTier } from './storage-placement-service.js';
import { HA_SHARED_VOLUME_AFFINITY } from '../tenant-placement/pod-placement.js';

/**
 * A tier change patches the tenant's Deployments with the scheduling the
 * deployers render, so a later deploy changes nothing. It skipped Auto tenants
 * (no primary node) entirely: one moved to HA kept the hard pin to its data
 * node, one moved to Local got none.
 */
function fixture(nodeName: string | null, volume: { attachedOn?: string; replicas?: string[] } = { attachedOn: 'sv3' }) {
  const patches: Array<{ name: string; body: { spec: { template: { spec: Record<string, unknown> } } } }> = [];
  const db = {
    select: (cols?: unknown) => ({
      from: () => ({
        where: () => (cols
          ? Promise.resolve([{ id: 'd1', name: 'web' }])
          : { limit: async () => [{ id: 't1', kubernetesNamespace: 'tenant-acme', nodeName }] }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  } as unknown as Database;
  const k8s = {
    core: {
      readNamespacedPersistentVolumeClaim: async () => ({ spec: { volumeName: 'pvc-1' } }),
      listNamespacedPod: async () => ({ items: [] }),
    },
    custom: {
      getNamespacedCustomObject: async () => (volume.attachedOn
        ? { status: { state: 'attached', currentNodeID: volume.attachedOn } }
        : { status: { state: 'detached' } }),
      listNamespacedCustomObject: async () => ({
        items: (volume.replicas ?? []).map((nodeID) => ({ spec: { nodeID }, status: { currentState: 'stopped' } })),
      }),
    },
    apps: {
      patchNamespacedDeployment: async (a: { name: string; body: never }) => { patches.push(a); return {}; },
    },
  } as unknown as K8sClients;
  const scheduling = (name: string) => patches.find((p) => p.name === name)!.body.spec.template.spec;
  return { db, k8s, scheduling };
}

describe('applyTenantTier — the scheduling it patches', () => {
  it('gives an Auto tenant moved to HA the shared-volume preference and takes its hard pin off', async () => {
    const f = fixture(null);
    await applyTenantTier(f.db, f.k8s, 't1', 'local', 'ha');
    expect(f.scheduling('web')).toEqual({ nodeSelector: null, affinity: { podAffinity: HA_SHARED_VOLUME_AFFINITY } });
    expect(f.scheduling('file-manager')).toEqual({ nodeSelector: null });
  });

  it('holds an Auto tenant moved to Local to its data node, file manager included', async () => {
    const f = fixture(null);
    await applyTenantTier(f.db, f.k8s, 't1', 'ha', 'local');
    expect(f.scheduling('web')).toEqual({ nodeSelector: { 'kubernetes.io/hostname': 'sv3' }, affinity: null });
    expect(f.scheduling('file-manager')).toEqual({ nodeSelector: { 'kubernetes.io/hostname': 'sv3' } });
  });

  it('leaves an Auto tenant moved to Local as it is while its data node cannot be told', async () => {
    // Detached, and two copies until Longhorn drops one: patching would take the
    // HA preference off and put no pin on.
    const f = fixture(null, { replicas: ['sv1', 'sv3'] });
    const res = await applyTenantTier(f.db, f.k8s, 't1', 'ha', 'local');
    expect(res.deploymentsAffinityPatched).toBe(0);
    expect(() => f.scheduling('web')).toThrow();
  });

  it('gives a pinned HA tenant the node preference and the shared-volume preference', async () => {
    const f = fixture('sv1');
    await applyTenantTier(f.db, f.k8s, 't1', 'local', 'ha');
    const affinity = f.scheduling('web').affinity as { nodeAffinity: unknown; podAffinity: unknown };
    expect(f.scheduling('web').nodeSelector).toBeNull();
    expect(JSON.stringify(affinity.nodeAffinity)).toContain('"sv1"');
    expect(affinity.podAffinity).toEqual(HA_SHARED_VOLUME_AFFINITY);
  });
});
