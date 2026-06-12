import { describe, it, expect } from 'vitest';
import {
  computeQuotaCrossings,
  complaintLevel,
  COMPLAINT_WARNING_RATE,
  COMPLAINT_CRITICAL_RATE,
} from './thresholds.js';

describe('computeQuotaCrossings', () => {
  const limits = new Map([['t1', { hourly: 50, daily: 100 }]]);

  it('reports 80% and 100% crossings per window independently', () => {
    const crossings = computeQuotaCrossings(
      [{ tenantId: 't1', hourSent: 40, daySent: 100 }],
      limits,
    );
    // hour: 40/50 = 80% -> [80]; day: 100/100 -> [80, 100]
    expect(crossings).toEqual(expect.arrayContaining([
      { tenantId: 't1', window: 'hour', threshold: 80, used: 40, limit: 50 },
      { tenantId: 't1', window: 'day', threshold: 80, used: 100, limit: 100 },
      { tenantId: 't1', window: 'day', threshold: 100, used: 100, limit: 100 },
    ]));
    expect(crossings).toHaveLength(3);
  });

  it('reports nothing below 80%', () => {
    expect(computeQuotaCrossings([{ tenantId: 't1', hourSent: 39, daySent: 79 }], limits)).toEqual([]);
  });

  it('skips blocked tenants (limit 0) — no usage warnings while suspended', () => {
    const blocked = new Map([['t1', { hourly: 0, daily: 0 }]]);
    expect(computeQuotaCrossings([{ tenantId: 't1', hourSent: 99, daySent: 99 }], blocked)).toEqual([]);
  });

  it('skips tenants with no resolvable limits', () => {
    expect(computeQuotaCrossings([{ tenantId: 'ghost', hourSent: 99, daySent: 99 }], limits)).toEqual([]);
  });
});

describe('complaintLevel', () => {
  it('maps the spec thresholds (0.1% warning, 0.3% critical, strict >)', () => {
    expect(complaintLevel(0)).toBeNull();
    expect(complaintLevel(COMPLAINT_WARNING_RATE)).toBeNull(); // exactly 0.1% does not fire
    expect(complaintLevel(0.0011)).toBe('warning');
    expect(complaintLevel(COMPLAINT_CRITICAL_RATE)).toBe('warning'); // exactly 0.3% stays warning
    expect(complaintLevel(0.0031)).toBe('critical');
    expect(complaintLevel(1)).toBe('critical');
  });
});
