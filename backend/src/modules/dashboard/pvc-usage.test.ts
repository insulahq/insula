import { describe, it, expect } from 'vitest';
import { joinPvcUsage } from './pvc-usage.js';
import { pvcStatsKey, type PvcFsStats } from '../node-health/kubelet-disk.js';

const MiB = 1048576;
const GiB = 1073741824;

const stats = (over: Partial<PvcFsStats> = {}): PvcFsStats => ({
  namespace: 'platform',
  pvcName: 'system-db-1',
  usedBytes: 701 * MiB,
  capacityBytes: 1945 * MiB,
  inodesUsed: null,
  inodes: null,
  ...over,
});

const asMap = (...s: PvcFsStats[]) =>
  new Map(s.map((x) => [pvcStatsKey(x.namespace, x.pvcName), x]));

describe('joinPvcUsage', () => {
  it('reports the filesystem figure, not the volume request', () => {
    // 2 GiB requested presents as 1945 MiB of ext4. The fill is against what
    // the workload can actually use.
    const [u] = joinPvcUsage(asMap(stats()), new Map([['platform/system-db-1', 2 * GiB]]));
    expect(u.capacityBytes).toBe(1945 * MiB);
    expect(u.fraction).toBeCloseTo(0.36, 2);
  });

  it('keeps a volume whose filesystem is slightly SMALLER than its request', () => {
    // Every real volume is: the filesystem takes its overhead off the top.
    // A margin that excluded these would silence the alert entirely.
    expect(joinPvcUsage(asMap(stats()), new Map([['platform/system-db-1', 2 * GiB]]))).toHaveLength(1);
  });

  it('drops a volume living on a shared filesystem', () => {
    // local-path is a directory on the node's root disk: the kubelet reports
    // 502 GiB of capacity for a PVC that asked for 30. Its fill is the NODE's,
    // which node-health already alerts on — counting it here would fan one
    // disk-pressure event out into an alarm per PVC on that node.
    const shared = stats({
      namespace: 'mail', pvcName: 'mail-stack-data',
      usedBytes: 94 * GiB, capacityBytes: 502 * GiB,
    });
    expect(joinPvcUsage(asMap(shared), new Map([['mail/mail-stack-data', 30 * GiB]]))).toHaveLength(0);
  });

  it('keeps a volume whose request is unknown', () => {
    // No PVC row is not evidence of a shared filesystem. Dropping it would
    // lose the alert for anything the PVC list failed to return.
    expect(joinPvcUsage(asMap(stats()), new Map())).toHaveLength(1);
  });

  it('drops a reading with no measurable fill instead of calling it empty', () => {
    expect(joinPvcUsage(asMap(stats({ capacityBytes: 0 })), new Map())).toHaveLength(0);
  });
});
