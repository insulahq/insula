import { describe, it, expect } from 'vitest';
import { bandwidthForecast } from './bandwidth-forecast';

const bw = (usedGb: number, limitGb = 100, cycleStart: string | null = '2026-10-01T00:00:00Z', capped = false) =>
  ({ usedGb, limitGb, usedPct: (usedGb / limitGb) * 100, capped, cycleStart, source: 'plan' as const });

describe('bandwidthForecast', () => {
  const now = new Date('2026-10-19T00:00:00Z');

  it('names the day the allowance runs out at the pace so far', () => {
    // 84 GB in 18 days → 4.67 GB/day; 16 GB left → ~3.4 days → 22 Oct.
    const text = bandwidthForecast(bw(84), now);
    expect(text).toMatch(/^Runs out around .*22.* at this rate$/);
  });

  it('says nothing when the pace keeps it inside the cycle', () => {
    expect(bandwidthForecast(bw(20), now)).toBeNull();
  });

  it('says nothing when it is already capped, has no allowance, or the cycle start is unknown', () => {
    expect(bandwidthForecast(bw(100, 100, '2026-10-01T00:00:00Z', true), now)).toBeNull();
    expect(bandwidthForecast(bw(10, 0), now)).toBeNull();
    expect(bandwidthForecast(bw(10, 100, null), now)).toBeNull();
  });

  it('does not guess from less than a day of the cycle', () => {
    expect(bandwidthForecast(bw(50, 100, '2026-10-18T12:00:00Z'), now)).toBeNull();
  });
});
