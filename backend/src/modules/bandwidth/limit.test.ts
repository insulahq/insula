import { describe, it, expect } from 'vitest';
import { resolveBandwidthLimit, DEFAULT_BANDWIDTH_GB_LIMIT } from './limit.js';

describe('resolveBandwidthLimit', () => {
  it('prefers a positive tenant override', () => {
    expect(resolveBandwidthLimit(500, 100)).toBe(500);
  });
  it('falls back to the plan limit when no override', () => {
    expect(resolveBandwidthLimit(null, 250)).toBe(250);
    expect(resolveBandwidthLimit(undefined, 250)).toBe(250);
  });
  it('falls back to the 100 GB default when neither is set/positive', () => {
    expect(resolveBandwidthLimit(null, null)).toBe(DEFAULT_BANDWIDTH_GB_LIMIT);
    expect(resolveBandwidthLimit(0, 0)).toBe(DEFAULT_BANDWIDTH_GB_LIMIT);
    expect(resolveBandwidthLimit(null, undefined)).toBe(100);
  });
  it('ignores a non-positive override and uses the plan', () => {
    expect(resolveBandwidthLimit(0, 250)).toBe(250);
    expect(resolveBandwidthLimit(-5, 250)).toBe(250);
  });
});
