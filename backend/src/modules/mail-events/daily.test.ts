import { describe, it, expect } from 'vitest';
import { fillDays } from './daily.js';

describe('fillDays', () => {
  const now = new Date('2026-10-19T00:30:00Z');

  it('lists every day of the window, oldest first, today last', () => {
    const days = fillDays([], 3, now);
    expect(days.map((d) => d.date)).toEqual(['2026-10-17', '2026-10-18', '2026-10-19']);
    expect(days.every((d) => d.sent === 0 && d.recipients === 0 && d.rateLimited === 0 && d.quotaRejected === 0)).toBe(true);
  });

  it('keeps the counts of the days that have rows and drops rows outside the window', () => {
    const days = fillDays([
      { date: '2026-10-18', sent: 4, recipients: 5, rateLimited: 1, quotaRejected: 0 },
      { date: '2026-10-01', sent: 99, recipients: 99, rateLimited: 0, quotaRejected: 0 },
    ], 2, now);
    expect(days).toEqual([
      { date: '2026-10-18', sent: 4, recipients: 5, rateLimited: 1, quotaRejected: 0 },
      { date: '2026-10-19', sent: 0, recipients: 0, rateLimited: 0, quotaRejected: 0 },
    ]);
  });

  it('uses the UTC day, not the local one, right after midnight UTC', () => {
    expect(fillDays([], 1, new Date('2026-10-19T00:00:00Z'))[0]!.date).toBe('2026-10-19');
    expect(fillDays([], 1, new Date('2026-10-18T23:59:59Z'))[0]!.date).toBe('2026-10-18');
  });
});
