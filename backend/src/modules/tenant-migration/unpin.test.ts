import { describe, expect, it } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { applyAutoPlacement } from './unpin.js';

const NS = 'tenant-acme-1234';

interface Deploy { name: string; replicas: number; node: string | null }

/** A tenant whose volume is held to node-a by a drain, its data on node-a. */
function cluster(o: { deployments: Deploy[]; attached?: string | null; failDeploymentPatch?: boolean; tier?: string }) {
  const log: string[] = [];
  const k8s = {
    core: {
      readNamespacedPersistentVolumeClaim: async () => ({ spec: { volumeName: 'pvc-1' } }),
      listNamespacedPod: async () => ({ items: [] }),
    },
    custom: {
      listNamespacedCustomObject: async ({ plural }: { plural: string }) => ({
        items: plural === 'volumes'
          ? [{ metadata: { name: 'pvc-1' }, spec: { numberOfReplicas: 1, nodeSelector: ['node-node-a'] }, status: { kubernetesStatus: { namespace: NS, lastPVCRefAt: '' } } }]
          : [{ spec: { nodeID: 'node-a', volumeName: 'pvc-1' }, status: { currentState: 'running' } }],
      }),
      getNamespacedCustomObject: async () => ({
        status: o.attached ? { state: 'attached', currentNodeID: o.attached } : { state: 'detached' },
      }),
      patchNamespacedCustomObject: async ({ name, body }: { name: string; body: { spec: { nodeSelector: string[] } } }) => {
        log.push(`volume:${name}:${body.spec.nodeSelector.join(',')}`);
        return {};
      },
    },
    apps: {
      listNamespacedDeployment: async () => ({
        items: o.deployments.map((d) => ({
          metadata: { name: d.name },
          spec: { replicas: d.replicas, template: { spec: d.node ? { nodeSelector: { 'kubernetes.io/hostname': d.node } } : {} } },
        })),
      }),
      patchNamespacedDeployment: async ({ name, body }: { name: string; body: { spec: { template: { spec: { nodeSelector: Record<string, string> } } } } }) => {
        if (o.failDeploymentPatch) throw new Error('forbidden');
        log.push(`pin:${name}:${body.spec.template.spec.nodeSelector['kubernetes.io/hostname']}`);
        return {};
      },
    },
  } as unknown as K8sClients;
  return { k8s, log };
}

describe('applyAutoPlacement', () => {
  it('takes the node tag off the volume and keeps the pods with the data, restarting nothing', async () => {
    // A running tenant where it belongs: its Deployment already says node-a.
    const { k8s, log } = cluster({ attached: 'node-a', deployments: [{ name: 'web', replicas: 1, node: 'node-a' }] });
    expect(await applyAutoPlacement(k8s, NS, 'local', 'node-a')).toEqual({ runsOn: 'node-a', volumesReleased: ['pvc-1'] });
    expect(log).toEqual(['volume:pvc-1:']);
  });

  it('points a stopped Deployment at the data, so its next start is there', async () => {
    const { k8s, log } = cluster({ deployments: [{ name: 'web', replicas: 0, node: 'node-b' }, { name: 'file-manager', replicas: 0, node: null }] });
    expect((await applyAutoPlacement(k8s, NS, 'local', 'node-b')).runsOn).toBe('node-a');
    expect(log).toEqual(['volume:pvc-1:', 'pin:web:node-a', 'pin:file-manager:node-a']);
  });

  it('never changes a running Deployment: Auto moves nothing', async () => {
    const { k8s, log } = cluster({ attached: 'node-a', deployments: [{ name: 'worker', replicas: 1, node: 'node-c' }] });
    await applyAutoPlacement(k8s, NS, 'local', 'node-a');
    expect(log.some((l) => l.startsWith('pin:'))).toBe(false);
  });

  it('leaves an HA tenant\'s pods alone: their pin is only a preference', async () => {
    const { k8s, log } = cluster({ deployments: [{ name: 'web', replicas: 0, node: 'node-b' }] });
    expect(await applyAutoPlacement(k8s, NS, 'ha', 'node-b')).toEqual({ runsOn: null, volumesReleased: ['pvc-1'] });
    expect(log).toEqual(['volume:pvc-1:']);
  });

  it('puts the volume tag back when the pods cannot be kept with the data', async () => {
    const { k8s, log } = cluster({ deployments: [{ name: 'web', replicas: 0, node: 'node-b' }], failDeploymentPatch: true });
    await expect(applyAutoPlacement(k8s, NS, 'local', 'node-b')).rejects.toThrow('could not keep the pods on node-a with the data: forbidden');
    expect(log).toEqual(['volume:pvc-1:', 'volume:pvc-1:node-node-a']);
  });
});
