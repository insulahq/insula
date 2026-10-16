import { describe, it, expect } from 'vitest';
import { triadFigures } from './resource-triad';

describe('triadFigures — memory cache', () => {
  it('keeps free as total less the larger of in use and committed, the cache drawn inside it', () => {
    // A node with no tenant on it: 4.9 GiB processes, 3.2 GiB cache, 3.5 committed.
    const f = triadFigures(4.9, 3.5, 14.4, 3.2);
    expect(f.free).toBeCloseTo(9.5);
    expect(f.cache).toBe(3.2);
    expect(f.cachePct).toBeCloseTo((3.2 / 14.4) * 100);
  });

  it('draws the cache in free when committed is the larger claim', () => {
    const f = triadFigures(4.65, 7.59, 14.4, 1.27);
    expect(f.free).toBeCloseTo(6.81);
    expect(f.cachePct).toBeCloseTo((1.27 / 14.4) * 100);
  });

  it('never draws or names more cache inside free than there is free', () => {
    // In use is measured against the node's allocatable, the cache against
    // its whole RAM: on a full node the two can add up past the total.
    const f = triadFigures(10, 0, 12, 5);
    expect(f.cachePct).toBeCloseTo((2 / 12) * 100);
    expect(f).toMatchObject({ cache: 5, cacheInFree: 2 });
    // Committed nearly the whole node: one GiB free, so one GiB of cache in it.
    expect(triadFigures(4, 11, 12, 5)).toMatchObject({ free: 1, cache: 5, cacheInFree: 1 });
  });

  it('changes nothing when there is no cache figure', () => {
    expect(triadFigures(6, 2, 8)).toMatchObject({ free: 2, cache: null, cachePct: 0 });
    expect(triadFigures(6, 2, 8, null)).toMatchObject({ cache: null, cachePct: 0 });
  });
});
