/**
 * The one retention rule: removed when older than the days OR outside the
 * newest N — whichever comes first — and never the newest copy.
 */
import { describe, it, expect } from 'vitest';
import {
  describeRetention,
  effectiveRetention,
  jobCount,
  JOB_UNLIMITED_COUNT,
  KEEP_EVERYTHING,
  limitsNothing,
  selectForRemoval,
} from './retention-policy.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const DAY = 86_400_000;
/** One copy a day, newest first: day 0 is today. */
const daily = (n: number) => Array.from({ length: n }, (_, i) => ({ createdAt: new Date(NOW.getTime() - i * DAY), key: `c${String(i).padStart(3, '0')}` }));
const keys = (xs: ReadonlyArray<{ key: string }>) => xs.map((x) => x.key);

describe('selectForRemoval', () => {
  it('days alone removes what is older than the window', () => {
    const removed = selectForRemoval(daily(20), { days: 14, count: null }, NOW);
    expect(keys(removed)).toEqual(['c015', 'c016', 'c017', 'c018', 'c019']);
  });

  it('count alone keeps the newest N', () => {
    expect(keys(selectForRemoval(daily(5), { days: null, count: 3 }, NOW))).toEqual(['c003', 'c004']);
  });

  it('with both, whichever removes a copy first wins — the count here', () => {
    // 14 days would keep 15 copies; the count keeps 5.
    expect(selectForRemoval(daily(20), { days: 14, count: 5 }, NOW)).toHaveLength(15);
  });

  it('with both, whichever removes a copy first wins — the days here', () => {
    // 48 would keep all 20; 7 days keeps 8.
    expect(keys(selectForRemoval(daily(20), { days: 7, count: 48 }, NOW))).toEqual(
      ['c008', 'c009', 'c010', 'c011', 'c012', 'c013', 'c014', 'c015', 'c016', 'c017', 'c018', 'c019'],
    );
  });

  it('never removes the newest copy, however old it is', () => {
    // Backups stopped 40 days ago: the days limit alone would leave nothing.
    const old = daily(45).slice(40);
    const removed = selectForRemoval(old, { days: 14, count: null }, NOW);
    expect(keys(removed)).toEqual(['c041', 'c042', 'c043', 'c044']);
  });

  it('orders by time, not by the order it was given, and breaks ties by key', () => {
    const same = new Date(NOW.getTime() - DAY);
    const copies = [
      { createdAt: same, key: 'a' },
      { createdAt: NOW, key: 'newest' },
      { createdAt: same, key: 'b' },
    ];
    // Newest, then b (key DESC), then a.
    expect(keys(selectForRemoval(copies, { days: null, count: 2 }, NOW))).toEqual(['a']);
  });

  it('keeps everything under no limit', () => {
    expect(selectForRemoval(daily(30), KEEP_EVERYTHING, NOW)).toEqual([]);
  });
});

describe('effectiveRetention', () => {
  it('a positive value limits; null and 0 do not', () => {
    expect(effectiveRetention('mail', { retentionDays: 7, retentionCount: 0 })).toEqual({ days: 7, count: null });
    expect(effectiveRetention('mail', { retentionDays: null, retentionCount: 48 })).toEqual({ days: null, count: 48 });
    expect(effectiveRetention('secrets_bundle', { retentionDays: 14, retentionCount: null })).toEqual({ days: 14, count: null });
  });

  it('a row that limits nothing keeps what its class did before the rule', () => {
    expect(effectiveRetention('tenant_bundle', { retentionDays: null, retentionCount: null })).toEqual({ days: 30, count: null });
    expect(effectiveRetention('mail', { retentionDays: 0, retentionCount: 0 })).toEqual({ days: null, count: 48 });
    expect(effectiveRetention('etcd_snapshot', { retentionDays: null, retentionCount: null })).toEqual({ days: null, count: 24 });
    expect(effectiveRetention('secrets_bundle', undefined)).toEqual({ days: null, count: 30 });
    expect(effectiveRetention('cluster_state', { retentionDays: null, retentionCount: 0 })).toEqual({ days: null, count: 14 });
  });

  it('a tenant-bundle row set to 0 days on purpose still means "never expire"', () => {
    expect(effectiveRetention('tenant_bundle', { retentionDays: 0, retentionCount: null })).toEqual(KEEP_EVERYTHING);
  });

  it('limitsNothing matches', () => {
    expect(limitsNothing({ retentionDays: 0, retentionCount: null })).toBe(true);
    expect(limitsNothing({ retentionDays: 1, retentionCount: null })).toBe(false);
  });
});

describe('jobCount', () => {
  it('a days-only policy tells the job a count it can never reach — never 0', () => {
    expect(jobCount({ days: 14, count: null })).toBe(JOB_UNLIMITED_COUNT);
    expect(jobCount({ days: 14, count: 5 })).toBe(5);
  });
});

describe('describeRetention', () => {
  it('reads as the rule', () => {
    expect(describeRetention({ days: 14, count: 48 })).toBe('14 days or the newest 48, whichever comes first');
    expect(describeRetention({ days: 1, count: null })).toBe('1 day');
    expect(describeRetention(KEEP_EVERYTHING)).toBe('everything (no limit)');
  });
});
