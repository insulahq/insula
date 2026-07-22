import { describe, it, expect } from 'vitest';
import { bandwidthThreshold } from './thresholds.js';

describe('bandwidthThreshold', () => {
  it('null below 80% or with no limit', () => {
    expect(bandwidthThreshold(79, 100)).toBeNull();
    expect(bandwidthThreshold(0, 100)).toBeNull();
    expect(bandwidthThreshold(50, 0)).toBeNull();
    expect(bandwidthThreshold(50, -1)).toBeNull();
  });
  it('80 at 80–89%', () => {
    expect(bandwidthThreshold(80, 100)).toBe(80);
    expect(bandwidthThreshold(89.9, 100)).toBe(80);
  });
  it('90 at 90–99%', () => {
    expect(bandwidthThreshold(90, 100)).toBe(90);
    expect(bandwidthThreshold(99.9, 100)).toBe(90);
  });
  it('100 at/over 100% (cap territory)', () => {
    expect(bandwidthThreshold(100, 100)).toBe(100);
    expect(bandwidthThreshold(250, 100)).toBe(100);
  });
  it('scales with the effective limit', () => {
    expect(bandwidthThreshold(400, 500)).toBe(80);   // 80%
    expect(bandwidthThreshold(500, 500)).toBe(100);
  });
});
