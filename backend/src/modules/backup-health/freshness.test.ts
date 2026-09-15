import { describe, it, expect } from 'vitest';
import {
  evaluateFreshness,
  countScheduledFires,
  DEFAULT_STALE_AFTER_FIRES,
} from './freshness.js';

const EVERY_30M = '*/30 * * * *';
const WEEKDAYS_3AM = '0 3 * * 1-5';
const d = (iso: string) => new Date(iso);

describe('countScheduledFires', () => {
  it('counts the fires between two times, excluding the producing run', () => {
    // 12:00 → 13:00 on */30 fires at 12:30 and 13:00. The 12:00 fire is the one
    // that produced the last success, not a miss.
    expect(countScheduledFires(EVERY_30M, d('2026-09-15T12:00:00Z'), d('2026-09-15T13:00:00Z'))).toBe(2);
  });

  it('respects date restrictions instead of assuming a fixed interval', () => {
    // Fri 03:00 → Mon 09:00 is 78 hours, but only ONE weekday fire is missed
    // (Monday 03:00). An elapsed-time threshold would cry outage all weekend.
    expect(countScheduledFires(WEEKDAYS_3AM, d('2026-09-11T03:00:00Z'), d('2026-09-14T09:00:00Z'))).toBe(1);
  });

  it('returns 0 when `to` is not after `from`', () => {
    expect(countScheduledFires(EVERY_30M, d('2026-09-15T12:00:00Z'), d('2026-09-15T12:00:00Z'))).toBe(0);
    expect(countScheduledFires(EVERY_30M, d('2026-09-15T13:00:00Z'), d('2026-09-15T12:00:00Z'))).toBe(0);
  });

  it('saturates rather than scanning an unbounded gap', () => {
    // A repo abandoned a year ago must not cost a year of minute iterations.
    const n = countScheduledFires(EVERY_30M, d('2025-09-15T00:00:00Z'), d('2026-09-15T00:00:00Z'), 2);
    expect(n).toBe(2 * 24 * 2); // 2 days of half-hours
  });
});

describe('evaluateFreshness', () => {
  it('reproduces the DEV outage as stale, with the real numbers', () => {
    // Last good mail snapshot 2026-09-11T19:31; noticed 2026-09-15T12:51.
    const r = evaluateFreshness({
      lastSuccessAt: d('2026-09-11T19:31:00Z'),
      cronExpression: EVERY_30M,
      now: d('2026-09-15T12:51:00Z'),
    });
    expect(r.verdict).toBe('stale');
    expect(r.missedFires).toBeGreaterThan(170);
    expect(r.ageMs).toBeGreaterThan(3 * 24 * 3_600_000);
  });

  it('calls a just-completed run fresh', () => {
    const r = evaluateFreshness({
      lastSuccessAt: d('2026-09-15T13:00:00Z'),
      cronExpression: EVERY_30M,
      now: d('2026-09-15T13:10:00Z'),
    });
    expect(r.verdict).toBe('fresh');
    expect(r.missedFires).toBe(0);
  });

  it('does not call a weekend stale on a weekdays-only schedule', () => {
    const r = evaluateFreshness({
      lastSuccessAt: d('2026-09-11T03:00:00Z'), // Friday
      cronExpression: WEEKDAYS_3AM,
      now: d('2026-09-13T12:00:00Z'), // Sunday
    });
    expect(r.missedFires).toBe(0);
    expect(r.verdict).toBe('fresh');
  });

  it('distinguishes "never ran" from "went stale"', () => {
    // A repo that never produced a backup is a setup problem; calling it stale
    // sends an operator looking for a regression that never happened.
    const r = evaluateFreshness({
      lastSuccessAt: null,
      cronExpression: EVERY_30M,
      now: d('2026-09-15T12:00:00Z'),
    });
    expect(r.verdict).toBe('never');
    expect(r.ageMs).toBeNull();
  });

  it('holds the previous verdict inside the grace', () => {
    // The band is now HALF AN INTERVAL rather than a count of missed runs, so
    // that alert latency scales with the schedule instead of punishing rare
    // backups. An alert that flaps is still an alert that is muted, so the
    // hold itself is unchanged — only what opens it.
    //
    // 30-min schedule: 12:30 is due and missed, grace runs to 12:45.
    const base = {
      lastSuccessAt: d('2026-09-15T12:00:00Z'),
      cronExpression: EVERY_30M,
      now: d('2026-09-15T12:40:00Z'), // 12:30 missed, 10 min late, grace is 15
    };
    expect(evaluateFreshness(base).missedFires).toBe(1);
    expect(evaluateFreshness({ ...base, previous: 'stale' }).verdict).toBe('stale');
    expect(evaluateFreshness({ ...base, previous: 'fresh' }).verdict).toBe('fresh');
  });

  it('goes stale half an interval late, without waiting for more misses', () => {
    // 12:30 due and missed; at 12:46 it is past half of the 30-minute
    // interval. The OLD rule held here and would not have called it stale
    // until 13:30 — three whole periods.
    const r = evaluateFreshness({
      lastSuccessAt: d('2026-09-15T12:00:00Z'),
      cronExpression: EVERY_30M,
      now: d('2026-09-15T12:46:00Z'),
      previous: 'fresh',
    });
    expect(r.missedFires).toBe(1);
    expect(r.verdict).toBe('stale');
  });

  it('reports a daily backup the same MORNING, not 3 days or half a day later', () => {
    // The outage this was built for: DEV went 3d 17h with every surface green.
    // Three missed days is obviously too late; so is half a period, because on
    // `0 3 * * *` the failure is knowable at 03:00 and a 12h grace sits on it
    // until 15:00 — overnight that is most of the window to act before the
    // next attempt. The grace is capped at an hour.
    const base = {
      lastSuccessAt: d('2026-09-14T03:00:30Z'),
      cronExpression: '0 3 * * *',
      previous: 'fresh' as const,
    };
    // 03:00 is due and missed. Still inside the 1h grace at 03:30.
    expect(evaluateFreshness({ ...base, now: d('2026-09-15T03:30:00Z') }).verdict).toBe('fresh');
    // Past it by 04:10 — reported ~25h after the last success, and a clear
    // 23h before the next scheduled attempt.
    expect(evaluateFreshness({ ...base, now: d('2026-09-15T04:10:00Z') }).verdict).toBe('stale');
  });

  it('keeps the grace proportional where the period is SHORT', () => {
    // The cap must not flatten short schedules into the same 1h wait: half of
    // a 30-minute interval is 15 minutes, well under the cap, so it still
    // applies.
    const base = {
      lastSuccessAt: d('2026-09-15T12:00:00Z'),
      cronExpression: EVERY_30M,
      previous: 'fresh' as const,
    };
    expect(evaluateFreshness({ ...base, now: d('2026-09-15T12:40:00Z') }).verdict).toBe('fresh');
    expect(evaluateFreshness({ ...base, now: d('2026-09-15T12:46:00Z') }).verdict).toBe('stale');
  });

  it('leaves the band as stale once the threshold is crossed', () => {
    const r = evaluateFreshness({
      lastSuccessAt: d('2026-09-15T12:00:00Z'),
      cronExpression: EVERY_30M,
      now: d('2026-09-15T13:35:00Z'), // 12:30, 13:00, 13:30
      previous: 'fresh',
    });
    expect(r.missedFires).toBe(3);
    expect(r.verdict).toBe('stale');
  });

  it('says unknown rather than guessing when the schedule is unusable', () => {
    for (const expr of [null, '', 'not a cron', '* * *', '@daily']) {
      const r = evaluateFreshness({
        lastSuccessAt: d('2026-09-15T12:00:00Z'),
        cronExpression: expr,
        now: d('2026-09-19T12:00:00Z'),
      });
      expect(r.verdict, `expr=${String(expr)}`).toBe('unknown');
    }
  });

  it('still reports an age when the verdict is unknown', () => {
    // The operator can act on "4 days since the last backup" even when we
    // cannot say whether that is on-schedule.
    const r = evaluateFreshness({
      lastSuccessAt: d('2026-09-15T12:00:00Z'),
      cronExpression: '@daily',
      now: d('2026-09-19T12:00:00Z'),
    });
    expect(r.ageMs).toBe(4 * 24 * 3_600_000);
  });
});
