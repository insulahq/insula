import { describe, expect, it } from 'vitest';
import {
  HA_SHARED_VOLUME_AFFINITY, platformPodPlacement, resolveAutoPlacement, tenantPodPlacementOf, tenantPodScheduling,
  TENANT_OVERHEAD_PRIORITY_CLASS,
} from './pod-placement.js';
import { carryQuiesceHold, STORAGE_PREQUIESCE_REPLICAS_ANNOTATION, STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';

describe('tenantPodScheduling', () => {
  it('hard-pins a local tenant to its primary node', () => {
    expect(tenantPodScheduling({ nodeName: 'sv1', storageTier: 'local' }))
      .toEqual({ nodeSelector: { 'kubernetes.io/hostname': 'sv1' } });
    // Unset tier has local semantics: the single replica only exists there.
    expect(tenantPodScheduling({ nodeName: 'sv1', storageTier: null }))
      .toEqual({ nodeSelector: { 'kubernetes.io/hostname': 'sv1' } });
  });

  it('only prefers the primary node on the HA tier, so pods can fail over', () => {
    expect(tenantPodScheduling({ nodeName: 'sv1', storageTier: 'ha' })).toEqual({
      affinity: {
        nodeAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [{
            weight: 100,
            preference: { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['sv1'] }] },
          }],
        },
        podAffinity: HA_SHARED_VOLUME_AFFINITY,
      },
    });
  });

  it('holds an HA tenant\'s pods together by preference, pinned or Auto — never by a hard rule', () => {
    // They share one ReadWriteOnce volume: one placed away from the others never starts.
    // An Auto HA tenant had no constraint at all.
    expect(tenantPodScheduling({ nodeName: null, storageTier: 'ha' })).toEqual({
      affinity: { podAffinity: HA_SHARED_VOLUME_AFFINITY },
    });
    const terms = HA_SHARED_VOLUME_AFFINITY.preferredDuringSchedulingIgnoredDuringExecution;
    expect(terms.map((t) => [t.weight, t.podAffinityTerm.labelSelector.matchLabels, t.podAffinityTerm.topologyKey])).toEqual([
      [100, { 'platform.io/managed': 'true' }, 'kubernetes.io/hostname'],
      [50, { 'platform.io/component': 'file-manager' }, 'kubernetes.io/hostname'],
    ]);
    // Required would count a dead node's terminating pods and strand failover.
    expect(JSON.stringify(tenantPodScheduling({ nodeName: 'sv1', storageTier: 'ha' }))).not.toContain('requiredDuring');
  });

  it('constrains nothing for an unpinned tenant', () => {
    expect(tenantPodScheduling({ nodeName: null, storageTier: 'local' })).toEqual({});
  });
});

describe('platformPodPlacement', () => {
  it('gives a platform pod the HA node preference but no pull toward the tenant\'s pods', () => {
    expect(platformPodPlacement({ nodeName: 'sv1', storageTier: 'ha' }).affinity).toEqual({
      nodeAffinity: {
        preferredDuringSchedulingIgnoredDuringExecution: [{
          weight: 100,
          preference: { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['sv1'] }] },
        }],
      },
    });
    expect(platformPodPlacement({ nodeName: null, storageTier: 'ha' })).toEqual({ priorityClassName: 'platform-tenant-overhead' });
  });

  it('★ pins a platform pod like the tenant and keeps it out of the tenant quota', () => {
    // Production: the private-worker server ran on another server (tenant
    // reported drifted) and its 25m was refused by the tenant's quota.
    expect(platformPodPlacement({ nodeName: 'sv1', storageTier: 'local' })).toEqual({
      nodeSelector: { 'kubernetes.io/hostname': 'sv1' },
      priorityClassName: TENANT_OVERHEAD_PRIORITY_CLASS,
    });
  });
});

describe('tenantPodPlacementOf', () => {
  it('reads the row and treats an unknown tier as unset', () => {
    expect(tenantPodPlacementOf({ nodeName: 'sv2', storageTier: 'ha' })).toEqual({ nodeName: 'sv2', storageTier: 'ha' });
    expect(tenantPodPlacementOf({ nodeName: null, storageTier: 'weird' })).toEqual({ nodeName: null, storageTier: null });
    expect(tenantPodPlacementOf(undefined)).toEqual({ nodeName: null, storageTier: null });
  });
});

describe('carryQuiesceHold', () => {
  const body = { metadata: { name: 'x', annotations: { a: 'b' } }, spec: { replicas: 1, template: {} } };

  it('keeps a storage hold and its replica count across a full replace', () => {
    const live = {
      metadata: { annotations: { [STORAGE_QUIESCED_ANNOTATION]: 'true', [STORAGE_PREQUIESCE_REPLICAS_ANNOTATION]: '1' } },
      spec: { replicas: 0 },
    };
    expect(carryQuiesceHold(live, body)).toEqual({
      metadata: {
        name: 'x',
        annotations: { a: 'b', [STORAGE_QUIESCED_ANNOTATION]: 'true', [STORAGE_PREQUIESCE_REPLICAS_ANNOTATION]: '1' },
      },
      spec: { replicas: 0, template: {} },
    });
  });

  it('changes nothing when no hold is set', () => {
    expect(carryQuiesceHold({ metadata: { annotations: {} }, spec: { replicas: 3 } }, body)).toBe(body);
    expect(carryQuiesceHold(undefined, body)).toBe(body);
  });
});

describe('resolveAutoPlacement', () => {
  // An Auto tenant keeps its pods on one host with its data: the node the
  // volume is attached to, else a running pod mounts it, else its replica.
  const cluster = (o: { attached?: string; replicas?: string[] }) => ({
    core: {
      readNamespacedPersistentVolumeClaim: async () => ({ spec: { volumeName: 'pvc-1' } }),
      listNamespacedPod: async () => ({ items: [] }),
    },
    custom: {
      getNamespacedCustomObject: async () => ({ status: o.attached ? { state: 'attached', currentNodeID: o.attached } : { state: 'detached' } }),
      listNamespacedCustomObject: async () => ({ items: (o.replicas ?? []).map((n) => ({ spec: { nodeID: n }, status: { currentState: 'running' } })) }),
    },
  }) as unknown as Parameters<typeof resolveAutoPlacement>[0];

  it('places an Auto Local-tier tenant on the node its volume is attached to, else its replica', async () => {
    expect(await resolveAutoPlacement(cluster({ attached: 'node-b', replicas: ['node-a'] }), 'tenant-x', { nodeName: null, storageTier: 'local' }))
      .toEqual({ nodeName: 'node-b', storageTier: 'local' });
    expect(await resolveAutoPlacement(cluster({ replicas: ['node-a'] }), 'tenant-x', { nodeName: null, storageTier: null }))
      .toEqual({ nodeName: 'node-a', storageTier: null });
  });

  it('leaves a pinned tenant, an HA tenant, one with no data yet, and a copy in flight as they are', async () => {
    const k8s = cluster({ attached: 'node-b' });
    expect(await resolveAutoPlacement(k8s, 'tenant-x', { nodeName: 'node-a', storageTier: 'local' })).toEqual({ nodeName: 'node-a', storageTier: 'local' });
    expect(await resolveAutoPlacement(k8s, 'tenant-x', { nodeName: null, storageTier: 'ha' })).toEqual({ nodeName: null, storageTier: 'ha' });
    expect(await resolveAutoPlacement(cluster({}), 'tenant-x', { nodeName: null, storageTier: 'local' })).toEqual({ nodeName: null, storageTier: 'local' });
    // Two replicas while a copy runs and nothing attached: no node to choose yet.
    expect(await resolveAutoPlacement(cluster({ replicas: ['node-a', 'node-b'] }), 'tenant-x', { nodeName: null, storageTier: 'local' }))
      .toEqual({ nodeName: null, storageTier: 'local' });
  });
});
