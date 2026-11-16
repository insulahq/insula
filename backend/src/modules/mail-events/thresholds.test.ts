import { describe, it, expect } from 'vitest';
import {
  computeQuotaCrossings,
  releaseTime,
  abuseLevel,
  ABUSE_WARN_DEFAULT,
  ABUSE_CRITICAL_DEFAULT,
} from './thresholds.js';

describe('computeQuotaCrossings', () => {
  const limits = new Map([['t1', { hourly: 50, daily: 100 }]]);
  const D = 'a.example.test';

  it('reports 80% and 100% crossings per window independently', () => {
    const crossings = computeQuotaCrossings(
      [{ tenantId: 't1', domain: D, hourSent: 40, daySent: 100 }],
      limits,
    );
    // hour: 40/50 = 80% -> [80]; day: 100/100 -> [80, 100]
    expect(crossings).toEqual(expect.arrayContaining([
      { tenantId: 't1', domain: D, window: 'hour', threshold: 80, used: 40, limit: 50 },
      { tenantId: 't1', domain: D, window: 'day', threshold: 80, used: 100, limit: 100 },
      { tenantId: 't1', domain: D, window: 'day', threshold: 100, used: 100, limit: 100 },
    ]));
    expect(crossings).toHaveLength(3);
  });

  // The limits are per mail domain. Two domains at 60 and 51 sent 111
  // together, which the tenant-wide sum reported as "exceeded 111/100" while
  // the mail server held nothing.
  it('holds each domain to the limit on its own, never their sum', () => {
    const crossings = computeQuotaCrossings([
      { tenantId: 't1', domain: 'a.example.test', hourSent: 10, daySent: 60 },
      { tenantId: 't1', domain: 'b.example.test', hourSent: 10, daySent: 51 },
    ], limits);
    expect(crossings).toEqual([]);
  });

  it('names the domain that crossed', () => {
    const crossings = computeQuotaCrossings([
      { tenantId: 't1', domain: 'a.example.test', hourSent: 0, daySent: 101 },
      { tenantId: 't1', domain: 'b.example.test', hourSent: 0, daySent: 10 },
    ], limits);
    expect(new Set(crossings.map((c) => c.domain))).toEqual(new Set(['a.example.test']));
  });

  it('reports nothing below 80%', () => {
    expect(computeQuotaCrossings([{ tenantId: 't1', domain: D, hourSent: 39, daySent: 79 }], limits)).toEqual([]);
  });

  it('skips blocked tenants (limit 0) — no usage warnings while suspended', () => {
    const blocked = new Map([['t1', { hourly: 0, daily: 0 }]]);
    expect(computeQuotaCrossings([{ tenantId: 't1', domain: D, hourSent: 99, daySent: 99 }], blocked)).toEqual([]);
  });

  it('skips tenants with no resolvable limits', () => {
    expect(computeQuotaCrossings([{ tenantId: 'ghost', domain: D, hourSent: 99, daySent: 99 }], limits)).toEqual([]);
  });
});

describe('releaseTime', () => {
  const NOW = new Date('2026-11-16T14:09:42Z');
  it('is the next full UTC hour for the hourly window and 00:00 UTC for the daily one', () => {
    expect(releaseTime('hour', NOW)).toBe('15:00 UTC');
    expect(releaseTime('day', NOW)).toBe('00:00 UTC (2026-11-17)');
  });
});

describe('abuseLevel', () => {
  const W = ABUSE_WARN_DEFAULT;   // 50
  const C = ABUSE_CRITICAL_DEFAULT; // 500

  it('is null below the warning threshold', () => {
    expect(abuseLevel(0, W, C)).toBeNull();
    expect(abuseLevel(W - 1, W, C)).toBeNull();
  });

  it('is warning at/above warn and below critical', () => {
    expect(abuseLevel(W, W, C)).toBe('warning');
    expect(abuseLevel(C - 1, W, C)).toBe('warning');
  });

  it('is critical at/above the critical threshold', () => {
    expect(abuseLevel(C, W, C)).toBe('critical');
    expect(abuseLevel(C + 10_000, W, C)).toBe('critical');
  });

  it('never inverts when thresholds are equal', () => {
    // getAbuseThresholds clamps critical >= warn; at equality, >= critical wins.
    expect(abuseLevel(100, 100, 100)).toBe('critical');
  });
});
