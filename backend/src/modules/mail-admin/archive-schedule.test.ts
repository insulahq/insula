/**
 * The mail archive schedule's due check. (The archive itself is dormant —
 * archive-dormant.ts — but this is the bug that made its schedule never fire,
 * and it must not come back with the feature.)
 *
 * The tick used to ask `computeNextFireAt(row, now) <= now`. That function
 * tells the card when the NEXT run is, and by construction returns a time
 * after `now`: over nine simulated days of one tick a minute it was due on 0
 * of 12,960 ticks, for hourly, daily and weekly alike.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_CATCH_UP_MS,
  computeNextFireAt,
  lastScheduledTime,
  maybeFireArchiveSchedule,
  scheduledRunDue,
  type ScheduleRow,
} from './archive-schedule.js';

const at = (iso: string) => new Date(iso);
const MIN = 60_000;
const row = (over: Partial<ScheduleRow>): ScheduleRow => ({ interval: 'daily', hourUtc: 2, weekdayUtc: 0, lastScheduledRunAt: null, ...over });

/** Tick once a minute (at second :30, as a timer started at an arbitrary second does); a due tick runs and stamps the last run. */
function simulate(start: ScheduleRow, fromIso: string, toIso: string, skip: (t: Date) => boolean = () => false): Date[] {
  let state = start;
  const fired: Date[] = [];
  for (let t = at(fromIso).getTime(); t < at(toIso).getTime(); t += MIN) {
    const now = new Date(t);
    if (skip(now)) continue;
    if (scheduledRunDue(state, now)) {
      fired.push(now);
      state = { ...state, lastScheduledRunAt: now };
    }
  }
  return fired;
}
const stamps = (ds: Date[]) => ds.map((d) => d.toISOString().slice(0, 16));

describe('lastScheduledTime', () => {
  it('hourly: the top of the current hour', () => {
    expect(lastScheduledTime(row({ interval: 'hourly' }), at('2026-10-05T14:37:10Z'))?.toISOString()).toBe('2026-10-05T14:00:00.000Z');
  });
  it('daily: today at the hour once it has passed, yesterday before', () => {
    expect(lastScheduledTime(row({ hourUtc: 2 }), at('2026-10-05T02:00:00Z'))?.toISOString()).toBe('2026-10-05T02:00:00.000Z');
    expect(lastScheduledTime(row({ hourUtc: 2 }), at('2026-10-05T01:59:59Z'))?.toISOString()).toBe('2026-10-04T02:00:00.000Z');
  });
  it('weekly: the most recent of that weekday at the hour', () => {
    // The fixture's "now" falls on a Monday (1); the Wednesday (3) before it is five days earlier.
    expect(lastScheduledTime(row({ interval: 'weekly', weekdayUtc: 3 }), at('2026-10-05T12:00:00Z'))?.toISOString()).toBe('2026-09-30T02:00:00.000Z');
    expect(lastScheduledTime(row({ interval: 'weekly', weekdayUtc: 1 }), at('2026-10-05T12:00:00Z'))?.toISOString()).toBe('2026-10-05T02:00:00.000Z');
    expect(lastScheduledTime(row({ interval: 'weekly', weekdayUtc: 1 }), at('2026-10-05T01:00:00Z'))?.toISOString()).toBe('2026-09-28T02:00:00.000Z');
  });
  it('off: nothing', () => {
    expect(lastScheduledTime(row({ interval: 'off' }), at('2026-10-05T12:00:00Z'))).toBeNull();
  });
});

describe('a schedule fires — once per scheduled time, within a minute of it', () => {
  it('the old due check never fired: the "next run" is always after now', () => {
    let due = 0;
    for (const r of [row({ interval: 'hourly' }), row({ interval: 'daily' }), row({ interval: 'weekly', weekdayUtc: 3 })]) {
      for (let t = at('2026-10-01T00:00:30Z').getTime(); t < at('2026-10-10T00:00:00Z').getTime(); t += MIN) {
        const next = computeNextFireAt(r, new Date(t));
        if (next && next <= new Date(t)) due += 1;
      }
    }
    expect(due).toBe(0);
  });

  it('hourly: 24 runs a day, each in the first minute of its hour', () => {
    const fired = simulate(row({ interval: 'hourly', lastScheduledRunAt: at('2026-10-01T00:00:05Z') }), '2026-10-01T00:00:30Z', '2026-10-03T00:00:00Z');
    expect(fired).toHaveLength(47); // 01:00 on the 1st through 23:00 on the 2nd
    expect(fired.every((d) => d.getUTCMinutes() === 0)).toBe(true);
  });

  it('daily at 02:00: one run a day, at 02:00', () => {
    const fired = simulate(row({ hourUtc: 2 }), '2026-10-01T12:00:30Z', '2026-10-05T12:00:00Z');
    expect(stamps(fired)).toEqual(['2026-10-02T02:00', '2026-10-03T02:00', '2026-10-04T02:00', '2026-10-05T02:00']);
  });

  it('weekly on Wednesday at 02:00: one run a week', () => {
    const fired = simulate(row({ interval: 'weekly', weekdayUtc: 3 }), '2026-10-01T00:00:30Z', '2026-10-20T00:00:00Z');
    expect(stamps(fired)).toEqual(['2026-10-07T02:00', '2026-10-14T02:00']);
  });

  it('enabled at 15:00 for "daily at 02:00": nothing until the next 02:00 — not at once because today\'s was missed', () => {
    expect(scheduledRunDue(row({ hourUtc: 2 }), at('2026-10-05T15:00:00Z'))).toBeNull();
    expect(stamps(simulate(row({ hourUtc: 2 }), '2026-10-05T15:00:30Z', '2026-10-06T03:00:00Z'))).toEqual(['2026-10-06T02:00']);
  });

  it('the API down at the scheduled time: the run is made when it is back within the catch-up window, skipped after it', () => {
    const down = (from: string, to: string) => (t: Date) => t >= at(from) && t < at(to);
    expect(stamps(simulate(row({ hourUtc: 2 }), '2026-10-05T12:00:30Z', '2026-10-06T12:00:00Z', down('2026-10-06T01:55:00Z', '2026-10-06T02:10:00Z'))))
      .toEqual(['2026-10-06T02:10']);
    expect(simulate(row({ hourUtc: 2 }), '2026-10-05T12:00:30Z', '2026-10-06T12:00:00Z', down('2026-10-06T01:55:00Z', '2026-10-06T02:30:00Z')))
      .toEqual([]);
    expect(ARCHIVE_CATCH_UP_MS).toBe(15 * MIN);
  });
});

describe('maybeFireArchiveSchedule', () => {
  /** A database holding one settings row; the claim is the compare-and-swap the real statement makes. */
  function fakeDb(initial: ScheduleRow) {
    let state = initial;
    let claims = 0;
    return {
      get row() { return state; },
      get claims() { return claims; },
      db: {
        select: () => ({ from: () => ({ where: async () => [{ interval: state.interval, hourUtc: state.hourUtc, weekdayUtc: state.weekdayUtc, lastScheduledRunAt: state.lastScheduledRunAt }] }) }),
        // Each caller read the row before claiming; only the first claim after a read finds it unchanged.
        execute: async () => { claims += 1; if (claims > 1) return { rowCount: 0 }; state = { ...state, lastScheduledRunAt: new Date() }; return { rowCount: 1 }; },
        update: () => ({ set: (v: { mailArchiveLastScheduledRunAt: Date | null }) => ({ where: async () => { state = { ...state, lastScheduledRunAt: v.mailArchiveLastScheduledRunAt }; } }) }),
      } as never,
    };
  }
  const quiet = { info: () => {}, warn: () => {} };

  it('starts the archive when a scheduled time has just passed', async () => {
    const f = fakeDb(row({ hourUtc: 2 }));
    const start = vi.fn(async () => ({ runId: 'r1' }));
    expect(await maybeFireArchiveSchedule(f.db, start, quiet, () => at('2026-10-06T02:00:30Z'))).toEqual({ fired: true, runId: 'r1' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does nothing between scheduled times', async () => {
    const f = fakeDb(row({ hourUtc: 2 }));
    const start = vi.fn(async () => ({ runId: 'r1' }));
    expect((await maybeFireArchiveSchedule(f.db, start, quiet, () => at('2026-10-06T15:00:00Z'))).fired).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(f.claims).toBe(0);
  });

  it('a second replica ticking in the same minute loses the claim and starts nothing', async () => {
    const f = fakeDb(row({ hourUtc: 2 }));
    const start = vi.fn(async () => ({ runId: 'r1' }));
    const now = () => at('2026-10-06T02:00:30Z');
    const [a, b] = await Promise.all([maybeFireArchiveSchedule(f.db, start, quiet, now), maybeFireArchiveSchedule(f.db, start, quiet, now)]);
    expect([a.fired, b.fired].filter(Boolean)).toHaveLength(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a start that fails gives the claim back, so the next tick tries again', async () => {
    const f = fakeDb(row({ hourUtc: 2 }));
    const start = vi.fn(async () => { throw new Error('another run is active'); });
    const r = await maybeFireArchiveSchedule(f.db, start, quiet, () => at('2026-10-06T02:00:30Z'));
    expect(r.fired).toBe(false);
    expect(f.row.lastScheduledRunAt).toBeNull();
  });
});
