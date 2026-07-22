import { describe, it, expect } from 'vitest';
import { hourBucketUtc, reapCutoffs, RETAIN_HOURLY_DAYS, RETAIN_DAILY_DAYS } from './usage-rollup.js';

describe('hourBucketUtc', () => {
  it('zeroes minutes/seconds/ms to the UTC hour', () => {
    const b = hourBucketUtc(new Date('2026-07-22T13:47:31.500Z'));
    expect(b.toISOString()).toBe('2026-07-22T13:00:00.000Z');
  });

  it('is stable across a whole hour (same bucket)', () => {
    const a = hourBucketUtc(new Date('2026-07-22T13:00:00.000Z'));
    const b = hourBucketUtc(new Date('2026-07-22T13:59:59.999Z'));
    expect(a.getTime()).toBe(b.getTime());
  });
});

describe('reapCutoffs', () => {
  const now = new Date('2026-07-22T13:47:00Z');
  const { hourlyCutoff, dailyCutoff } = reapCutoffs(now);

  it('day-aligns the hourly cutoff (only complete days past 30d are folded)', () => {
    // 30 days before 2026-07-22T00:00Z = 2026-06-22T00:00Z
    expect(hourlyCutoff.toISOString()).toBe('2026-06-22T00:00:00.000Z');
  });

  it('places hourly cutoff exactly RETAIN_HOURLY_DAYS before today-start', () => {
    const todayStart = Date.UTC(2026, 6, 22);
    expect(todayStart - hourlyCutoff.getTime()).toBe(RETAIN_HOURLY_DAYS * 86_400_000);
  });

  it('places daily cutoff RETAIN_DAILY_DAYS before now', () => {
    expect(now.getTime() - dailyCutoff.getTime()).toBe(RETAIN_DAILY_DAYS * 86_400_000);
  });
});
