import { describe, it, expect } from 'vitest';
import { computeNodeDiskPct } from './kubelet-disk.js';

describe('computeNodeDiskPct', () => {
  it('returns byte-fill percentage', () => {
    expect(computeNodeDiskPct({ usedBytes: 75, capacityBytes: 100 })).toBe(75);
  });

  it('returns inode-fill percentage when higher than byte-fill', () => {
    // 50% bytes but 92% inodes → the worse signal wins (inode exhaustion also
    // causes DiskPressure eviction).
    expect(computeNodeDiskPct({
      usedBytes: 50, capacityBytes: 100,
      inodesUsed: 92, inodes: 100,
    })).toBe(92);
  });

  it('takes byte-fill when it is the worse signal', () => {
    expect(computeNodeDiskPct({
      usedBytes: 96, capacityBytes: 100,
      inodesUsed: 10, inodes: 100,
    })).toBe(96);
  });

  it('rounds to one decimal place', () => {
    expect(computeNodeDiskPct({ usedBytes: 1, capacityBytes: 3 })).toBe(33.3);
  });

  it('returns null when nothing is measurable', () => {
    expect(computeNodeDiskPct(undefined)).toBeNull();
    expect(computeNodeDiskPct({})).toBeNull();
    expect(computeNodeDiskPct({ usedBytes: 5 })).toBeNull(); // no capacity
    expect(computeNodeDiskPct({ usedBytes: 5, capacityBytes: 0 })).toBeNull(); // div-by-zero guard
  });

  it('ignores inode fields when denominator is zero', () => {
    expect(computeNodeDiskPct({
      usedBytes: 40, capacityBytes: 100,
      inodesUsed: 5, inodes: 0,
    })).toBe(40);
  });
});
