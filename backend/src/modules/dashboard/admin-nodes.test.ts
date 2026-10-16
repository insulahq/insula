/**
 * readAdminNodes — the per-node figures behind the dashboard's Nodes strip and
 * Cluster → Nodes. Pinned here: each node's disk as in use / committed / total
 * from Longhorn's node status, and "not measured" (null) rather than an empty
 * disk when Longhorn cannot say.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { readAdminNodes, clusterMemoryUsage } from './admin-service.js';
import { readNodeMemoryStats } from '../node-health/kubelet-disk.js';

vi.mock('../node-health/kubelet-disk.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../node-health/kubelet-disk.js')>()),
  readNodeMemoryStats: vi.fn(),
}));

const GB = 1e9;
const GiB = 1024 ** 3;

beforeEach(() => {
  vi.mocked(readNodeMemoryStats).mockResolvedValue(new Map());
});

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

  it('keeps the disk to the megabyte, so its GiB figure matches the Longhorn row to the tenth', async () => {
    // DEV's disk: 82,086,711,296 bytes is 76.449 GiB. Rounded to 82.09 GB it
    // would read 76.45 → "76.5 GiB" beside Longhorn's "76.4 GiB".
    const nodes = await readAdminNodes(db, k8sWith(async () => ({ items: [{
      metadata: { name: 'n1' },
      status: { diskStatus: { a: { storageMaximum: 82_086_711_296, storageAvailable: 58_091_110_400, storageScheduled: 13_958_643_712 } } },
    }] })));
    const disk = nodes.find((n) => n.name === 'n1')!.disk!;
    expect(disk.total).toBe(82.087);
    expect(((disk.total * 1e9) / 1024 ** 3).toFixed(1)).toBe((82_086_711_296 / 1024 ** 3).toFixed(1));
  });

  it('says a node Longhorn does not know is not measured, not empty', async () => {
    const nodes = await readAdminNodes(db, k8sWith(async () => ({ items: [] })));
    expect(nodes.map((n) => n.disk)).toEqual([null, null]);
  });

  it('keeps every node when Longhorn cannot be read, its disk not measured', async () => {
    const nodes = await readAdminNodes(db, k8sWith(async () => { throw new Error('longhorn down'); }));
    expect(nodes.map((n) => [n.name, n.disk])).toEqual([['n1', null], ['n2', null]]);
  });

  it('counts memory in use as process memory, and the cache in the working set apart from it', async () => {
    // The metrics API says 2 GiB (its working set); the kubelet splits that
    // into what processes hold and the page cache the kernel can hand back.
    vi.mocked(readNodeMemoryStats).mockResolvedValue(new Map([
      ['n1', { processBytes: 1.5 * GiB, cacheBytes: 0.5 * GiB }],
    ]));
    const nodes = await readAdminNodes(db, k8sWith(async () => ({ items: [] })));
    expect(readNodeMemoryStats).toHaveBeenCalledWith(['n1', 'n2'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
    // Inside the dashboard's 4 s deadline for the whole nodes section, with
    // room for the reads that run after it.
    expect(vi.mocked(readNodeMemoryStats).mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(3_000);
    expect(nodes.find((n) => n.name === 'n1')!.memory).toMatchObject({ inUse: 1.5, cache: 0.5, committed: 1, total: 8 });
    // n2 has neither a kubelet split nor a metrics sample: not measured, both.
    expect(nodes.find((n) => n.name === 'n2')!.memory).toMatchObject({ inUse: null, cache: null });
  });

  it('falls back to the working set, cache not measured, when the kubelet does not answer', async () => {
    const nodes = await readAdminNodes(db, k8sWith(async () => ({ items: [] })));
    expect(nodes.find((n) => n.name === 'n1')!.memory).toMatchObject({ inUse: 2, cache: null });
  });

  it('still lists the nodes when the kubelet reader throws', async () => {
    vi.mocked(readNodeMemoryStats).mockRejectedValue(new Error('apiserver proxy down'));
    const nodes = await readAdminNodes(db, k8sWith(async () => ({ items: [] })));
    expect(nodes.find((n) => n.name === 'n1')!.memory).toMatchObject({ inUse: 2, cache: null });
  });
});

describe('clusterMemoryUsage', () => {
  const mem = (inUse: number | null, cache: number | null | undefined) =>
    ({ memory: { inUse, cache, committed: 0, total: 16, unit: 'GiB', kind: 'reserve' as const } });

  it('sums process memory and cache when every node was split', () => {
    expect(clusterMemoryUsage([mem(4.85, 3.19), mem(4.65, 1.27)])).toEqual({ inUse: 9.5, cache: 4.46 });
  });

  it('puts the whole cluster back on working set when one node was not split', () => {
    // 4.85 + 3.19 is the split node's working set; 5.92 is the other node's.
    expect(clusterMemoryUsage([mem(4.85, 3.19), mem(5.92, null)])).toEqual({ inUse: 13.96, cache: null });
  });

  it('is unknown when any node is unmeasured', () => {
    expect(clusterMemoryUsage([mem(4.85, 3.19), mem(null, null)])).toEqual({ inUse: null, cache: null });
  });

  it('draws no cache for a cluster with no nodes', () => {
    expect(clusterMemoryUsage([]).cache).toBeNull();
  });
});
