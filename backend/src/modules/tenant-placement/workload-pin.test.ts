import { describe, expect, it } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { hostnamePinOf, pinNodesOf, workloadPinNodes } from './workload-pin.js';

const selector = (node: string) => ({ nodeSelector: { 'kubernetes.io/hostname': node } });
const required = (values: string[]) => ({
  affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: {
    nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values }] }],
  } } },
});
const workload = (name: string, spec: object) => ({ metadata: { name }, spec: { template: { spec } } });

describe('hostnamePinOf', () => {
  it('reads the platform nodeSelector', () => {
    expect(hostnamePinOf(selector('sv2.example.test'))).toEqual({ node: 'sv2.example.test', kind: 'nodeSelector' });
  });

  it('reads a required affinity term on one node', () => {
    expect(hostnamePinOf(required(['node-a']))).toEqual({ node: 'node-a', kind: 'nodeAffinity' });
  });

  it('holds nothing for a term naming several nodes, a soft preference, or no constraint', () => {
    expect(hostnamePinOf(required(['node-a', 'node-b']))).toBeNull();
    expect(hostnamePinOf({
      affinity: { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{
        weight: 100, preference: { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['node-a'] }] },
      }] } },
    } as never)).toBeNull();
    expect(hostnamePinOf({})).toBeNull();
    expect(hostnamePinOf(undefined)).toBeNull();
  });
});

describe('pinNodesOf', () => {
  it('lists each node once, sorted, and ignores the file manager', () => {
    expect(pinNodesOf([
      workload('web', selector('node-b')),
      workload('db', required(['node-b'])),
      workload('file-manager', selector('node-a')),
      workload('cron-runner', {}),
    ])).toEqual(['node-b']);
    expect(pinNodesOf([workload('web', selector('node-b')), workload('db', selector('node-a'))])).toEqual(['node-a', 'node-b']);
  });
});

describe('workloadPinNodes', () => {
  it('reads Deployments and StatefulSets', async () => {
    const k8s = {
      apps: {
        listNamespacedDeployment: async () => ({ items: [workload('web', selector('node-a'))] }),
        listNamespacedStatefulSet: async () => ({ items: [workload('db', selector('node-a'))] }),
      },
    } as unknown as K8sClients;
    await expect(workloadPinNodes(k8s, 'tenant-acme')).resolves.toEqual(['node-a']);
  });

  it('throws when the cluster cannot be read — "no pin" from a failed list would be a wrong answer', async () => {
    const k8s = {
      apps: {
        listNamespacedDeployment: async () => { throw new Error('API down'); },
        listNamespacedStatefulSet: async () => ({ items: [] }),
      },
    } as unknown as K8sClients;
    await expect(workloadPinNodes(k8s, 'tenant-acme')).rejects.toThrow('API down');
  });
});
