import { describe, it, expect, vi } from 'vitest';
import { computeNodeDiskPct, computeNodeMemory, computePvcFillFraction, settleWithin } from './kubelet-disk.js';

describe('settleWithin', () => {
  it('gives the fallback once the deadline passes, however long the promise would take', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<string>(() => { /* a kubelet that never answers */ });
      const result = settleWithin(never, 2_500, null);
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(result).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives the answer when it arrives first', async () => {
    await expect(settleWithin(Promise.resolve('summary'), 2_500, null)).resolves.toBe('summary');
  });
});

describe('computeNodeMemory', () => {
  it('splits the working set into process memory and the cache counted in it', () => {
    // A production node with no tenant on it: working set 8.04 GiB, 4.85 GiB of it processes.
    expect(computeNodeMemory({ workingSetBytes: 8_000, rssBytes: 4_850, usageBytes: 12_000 }))
      .toEqual({ processBytes: 4_850, cacheBytes: 3_150 });
  });

  it('never reports negative cache when the two samples disagree', () => {
    expect(computeNodeMemory({ workingSetBytes: 4_000, rssBytes: 4_100 }))
      .toEqual({ processBytes: 4_100, cacheBytes: 0 });
  });

  it('is not measured when either figure is missing', () => {
    expect(computeNodeMemory(undefined)).toBeNull();
    expect(computeNodeMemory({ workingSetBytes: 8_000 })).toBeNull();
    expect(computeNodeMemory({ rssBytes: 4_850 })).toBeNull();
  });
});

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

describe('computePvcFillFraction', () => {
  const stats = (over: Partial<Parameters<typeof computePvcFillFraction>[0]> = {}) => ({
    namespace: 'platform', pvcName: 'system-db-1',
    usedBytes: 50, capacityBytes: 100, inodesUsed: null, inodes: null,
    ...over,
  });

  it('is the byte fill when only bytes are measurable', () => {
    expect(computePvcFillFraction(stats())).toBeCloseTo(0.5);
  });

  it('takes the WORSE of bytes and inodes', () => {
    // A volume out of inodes refuses writes while df still shows it half
    // empty — reporting the byte figure alone would call that healthy.
    expect(computePvcFillFraction(stats({ inodesUsed: 97, inodes: 100 }))).toBeCloseTo(0.97);
    expect(computePvcFillFraction(stats({ usedBytes: 99, inodesUsed: 1, inodes: 100 }))).toBeCloseTo(0.99);
  });

  it('returns null rather than a comfortable zero when nothing is measurable', () => {
    expect(computePvcFillFraction(undefined)).toBeNull();
    expect(computePvcFillFraction(stats({ capacityBytes: 0 }))).toBeNull();
  });
});
