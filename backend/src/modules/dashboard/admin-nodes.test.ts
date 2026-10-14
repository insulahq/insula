/**
 * readAdminNodes — the per-node figures behind the dashboard's Nodes strip and
 * Cluster → Nodes. Pinned here: each node's disk as in use / committed / total
 * from Longhorn's node status, and "not measured" (null) rather than an empty
 * disk when Longhorn cannot say.
 */
import { describe, it, expect } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { readAdminNodes } from './admin-service.js';

const GB = 1e9;

const node = (name: string) => ({
  metadata: { name, labels: {} },
  status: { allocatable: { cpu: '4', memory: '8Gi' }, conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1' } },
});

function k8sWith(longhorn: () => Promise<unknown>): K8sClients {
  return {
    core: {
      listNode: async () => ({ items: [node('n1'), node('n2')] }),
      listPodForAllNamespaces: async () => ({ items: [
        { spec: { nodeName: 'n1', containers: [{ resources: { requests: { cpu: '500m', memory: '1Gi' } } }] }, status: { phase: 'Running' } },
      ] }),
    },
    custom: {
      listClusterCustomObject: async () => ({ items: [{ metadata: { name: 'n1' }, usage: { cpu: '250000000n', memory: '2097152Ki' } }] }),
      listNamespacedCustomObject: longhorn,
    },
  } as unknown as K8sClients;
}

const db = { execute: async () => ({ rows: [] }) } as unknown as Database;

describe('readAdminNodes', () => {
  it('gives each node its disk: in use, committed to volumes, and total, summed over its disks', async () => {
    const nodes = await readAdminNodes(db, k8sWith(async () => ({ items: [{
      metadata: { name: 'n1' },
      status: { diskStatus: {
        a: { storageMaximum: 100 * GB, storageAvailable: 60 * GB, storageScheduled: 70 * GB },
        b: { storageMaximum: '50000000000', storageAvailable: '50000000000', storageScheduled: '0' },
      } },
    }] })));
    const n1 = nodes.find((n) => n.name === 'n1')!;
    expect(n1.disk).toEqual({ inUse: 40, committed: 70, total: 150, unit: 'GB', kind: 'reserve' });
    // CPU and memory keep their own figures beside it.
    expect(n1.cpu).toMatchObject({ inUse: 0.25, committed: 0.5, total: 4 });
    expect(n1.memory).toMatchObject({ inUse: 2, committed: 1, total: 8 });
  });

  it('says a node Longhorn does not know is not measured, not empty', async () => {
    const nodes = await readAdminNodes(db, k8sWith(async () => ({ items: [] })));
    expect(nodes.map((n) => n.disk)).toEqual([null, null]);
  });

  it('keeps every node when Longhorn cannot be read, its disk not measured', async () => {
    const nodes = await readAdminNodes(db, k8sWith(async () => { throw new Error('longhorn down'); }));
    expect(nodes.map((n) => [n.name, n.disk])).toEqual([['n1', null], ['n2', null]]);
  });
});
