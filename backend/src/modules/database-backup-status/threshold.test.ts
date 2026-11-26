import { describe, expect, it } from 'vitest';
import { STALE_GRACE_MS, staleThresholdMs } from './threshold.js';

const H = 3_600_000;
const D = 24 * H;
// A Wednesday, outside any DST change.
const NOW = new Date('2026-11-25T12:00:00Z');

describe('staleThresholdMs — the longest gap between scheduled runs, plus grace', () => {
  it('daily → 26 hours', () => {
    expect(staleThresholdMs('30 1 * * *', 'UTC', NOW)).toBe(D + STALE_GRACE_MS);
  });

  it('weekdays only → the weekend gap, so Monday is not called overdue', () => {
    expect(staleThresholdMs('0 2 * * 1-5', 'UTC', NOW)).toBe(3 * D + STALE_GRACE_MS);
  });

  it('weekly → a week and two hours', () => {
    expect(staleThresholdMs('0 3 * * 0', 'UTC', NOW)).toBe(7 * D + STALE_GRACE_MS);
  });

  it('several times a day → the longest of the gaps', () => {
    expect(staleThresholdMs('0 1,13 * * *', 'UTC', NOW)).toBe(12 * H + STALE_GRACE_MS);
    expect(staleThresholdMs('0 1,5 * * *', 'UTC', NOW)).toBe(20 * H + STALE_GRACE_MS);
  });

  it('monthly → read over the longer scan', () => {
    const t = staleThresholdMs('0 3 1 * *', 'UTC', NOW)!;
    // December 1 → January 1 is 31 days.
    expect(t).toBe(31 * D + STALE_GRACE_MS);
  });

  it('a schedule that never fires, or none at all, expects nothing', () => {
    expect(staleThresholdMs('0 0 30 2 *', 'UTC', NOW)).toBeNull();
    expect(staleThresholdMs('', 'UTC', NOW)).toBeNull();
    expect(staleThresholdMs(null, 'UTC', NOW)).toBeNull();
    expect(staleThresholdMs('not a cron', 'UTC', NOW)).toBeNull();
  });

  it('a daily run in a zone that leaves summer time waits the 25-hour day', () => {
    // Europe/Berlin falls back on 2026-10-25: the 01:30 local run moves an hour later in UTC.
    expect(staleThresholdMs('30 1 * * *', 'Europe/Berlin', new Date('2026-10-22T12:00:00Z'))).toBe(25 * H + STALE_GRACE_MS);
  });
});
