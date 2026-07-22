import { describe, it, expect } from 'vitest';
import { monthStartUtc, isNewCycle, bytesToGb } from './meter.js';

describe('monthStartUtc', () => {
  it('returns UTC first-of-month 00:00', () => {
    const d = monthStartUtc(new Date('2026-07-22T06:45:12.000Z'));
    expect(d.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });
  it('handles a January instant', () => {
    expect(monthStartUtc(new Date('2026-01-31T23:59:59Z')).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('isNewCycle', () => {
  const now = new Date('2026-07-22T06:00:00Z');
  it('true when no cycle start recorded', () => {
    expect(isNewCycle(null, now)).toBe(true);
    expect(isNewCycle(undefined, now)).toBe(true);
  });
  it('false within the same UTC month', () => {
    expect(isNewCycle(new Date('2026-07-01T00:00:00Z'), now)).toBe(false);
    expect(isNewCycle(new Date('2026-07-22T05:00:00Z'), now)).toBe(false);
  });
  it('true when the cycle start is a prior month', () => {
    expect(isNewCycle(new Date('2026-06-30T23:59:59Z'), now)).toBe(true);
  });
  it('true across a year boundary', () => {
    expect(isNewCycle(new Date('2025-12-31T00:00:00Z'), new Date('2026-01-01T00:10:00Z'))).toBe(true);
  });
});

describe('bytesToGb', () => {
  it('uses decimal GB (1e9), the bandwidth billing convention', () => {
    expect(bytesToGb(1_000_000_000)).toBe(1);
    expect(bytesToGb(2_500_000_000)).toBe(2.5);
    expect(bytesToGb(0)).toBe(0);
  });
});
