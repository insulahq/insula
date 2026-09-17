import { describe, it, expect } from 'vitest';
import { getNextRunTime, parseCron, NEVER, isValidTimeZone } from './cron-expression.js';

const at = (iso: string) => new Date(iso);

describe('getNextRunTime', () => {
  describe('the regression this module exists for', () => {
    it('fires a nightly job once a night, not once a minute', () => {
      // The old implementation returned lastRun + 60s for any schedule whose
      // minute field was not */N — so `0 3 * * *` ran 1440 times a day.
      const lastRun = at('2026-09-16T03:00:00Z');
      expect(getNextRunTime('0 3 * * *', lastRun)).toEqual(at('2026-09-17T03:00:00Z'));
    });

    it('fires an hourly job on the hour it was given', () => {
      expect(getNextRunTime('30 * * * *', at('2026-09-16T12:30:00Z')))
        .toEqual(at('2026-09-16T13:30:00Z'));
    });

    it('aligns */15 to the quarter hour instead of 15 minutes after the last run', () => {
      // Old behaviour: 12:07 + 15m = 12:22. Real cron fires at :15.
      expect(getNextRunTime('*/15 * * * *', at('2026-09-16T12:07:00Z')))
        .toEqual(at('2026-09-16T12:15:00Z'));
    });
  });

  it('runs every minute for * * * * *', () => {
    expect(getNextRunTime('* * * * *', at('2026-09-16T12:00:00Z')))
      .toEqual(at('2026-09-16T12:01:00Z'));
  });

  it('ignores seconds on the last run', () => {
    expect(getNextRunTime('* * * * *', at('2026-09-16T12:00:42Z')))
      .toEqual(at('2026-09-16T12:01:00Z'));
  });

  it('crosses midnight', () => {
    expect(getNextRunTime('0 0 * * *', at('2026-09-16T00:00:00Z')))
      .toEqual(at('2026-09-17T00:00:00Z'));
  });

  it('crosses a year boundary', () => {
    expect(getNextRunTime('0 0 1 1 *', at('2026-01-01T00:00:00Z')))
      .toEqual(at('2027-01-01T00:00:00Z'));
  });

  it('finds the next 29 February without scanning minute by minute', () => {
    expect(getNextRunTime('0 0 29 2 *', at('2026-03-01T00:00:00Z')))
      .toEqual(at('2028-02-29T00:00:00Z'));
  });

  it('handles day-of-week', () => {
    // 2026-09-16 is a Wednesday; the next Monday is the 21st.
    expect(getNextRunTime('0 9 * * 1', at('2026-09-16T12:00:00Z')))
      .toEqual(at('2026-09-21T09:00:00Z'));
  });

  it('treats 7 as Sunday', () => {
    expect(getNextRunTime('0 9 * * 7', at('2026-09-16T12:00:00Z')))
      .toEqual(at('2026-09-20T09:00:00Z'));
  });

  it('ORs day-of-month with day-of-week when both are restricted', () => {
    // POSIX: "the 13th OR a Friday", not "Friday the 13th".
    // From Wed 2026-09-16 the next hit is Friday the 18th, not the 13th of
    // next month.
    expect(getNextRunTime('0 0 13 * 5', at('2026-09-16T12:00:00Z')))
      .toEqual(at('2026-09-18T00:00:00Z'));
  });

  it('supports lists', () => {
    expect(getNextRunTime('0,30 * * * *', at('2026-09-16T12:05:00Z')))
      .toEqual(at('2026-09-16T12:30:00Z'));
  });

  it('supports ranges with a step', () => {
    // 09-17/2 = 9, 11, 13, 15, 17
    expect(getNextRunTime('0 9-17/2 * * *', at('2026-09-16T10:00:00Z')))
      .toEqual(at('2026-09-16T11:00:00Z'));
  });

  it('supports a bare start with a step', () => {
    // 5/15 = 5, 20, 35, 50
    expect(getNextRunTime('5/15 * * * *', at('2026-09-16T12:06:00Z')))
      .toEqual(at('2026-09-16T12:20:00Z'));
  });

  describe('a job that has never run is measured from its creation time', () => {
    it('waits for its next scheduled slot instead of firing immediately', () => {
      // The original implementation used the epoch as the base, so every new job
      // was "due" the moment it was saved, whatever its schedule said.
      const created = at('2026-09-16T12:00:00Z');
      expect(getNextRunTime('0 3 * * *', created)).toEqual(at('2026-09-17T03:00:00Z'));
    });

    it('starts within a minute for * * * * *', () => {
      const created = at('2026-09-16T12:00:30Z');
      expect(getNextRunTime('* * * * *', created)).toEqual(at('2026-09-16T12:01:00Z'));
    });

    it('returns the same answer however many times it is asked', () => {
      // The scheduler re-evaluates every 30 seconds. An answer computed from
      // `now` moves with each call, which is how a never-run job stayed at
      // "Never" on a real cluster — see isJobDue in scheduler.test.ts.
      const created = at('2026-09-16T12:00:30Z');
      const first = getNextRunTime('* * * * *', created, at('2026-09-16T12:00:40Z'));
      const later = getNextRunTime('* * * * *', created, at('2026-09-16T12:09:00Z'));
      expect(later).toEqual(first);
    });
  });

  describe('expressions that cannot be honoured stay dormant', () => {
    // Returning the epoch (the old behaviour) made a malformed schedule "due"
    // on every single poll — with deployment crons that is a command loop.
    it.each([
      ['wrong field count', 'bad schedule'],
      ['too few fields', '* * * *'],
      ['minute out of range', '60 * * * *'],
      ['hour out of range', '0 24 * * *'],
      ['day 0', '0 0 0 * *'],
      ['month 13', '0 0 1 13 *'],
      ['weekday 8', '0 0 * * 8'],
      ['zero step', '*/0 * * * *'],
      ['inverted range', '0 17-9 * * *'],
      ['empty list item', '0,, * * * *'],
    ])('%s', (_label, schedule) => {
      expect(getNextRunTime(schedule, at('2026-09-16T12:00:00Z'))).toEqual(NEVER);
    });

    it('is always in the future, so a bad schedule never fires', () => {
      expect(NEVER.getTime()).toBeGreaterThan(Date.now());
    });
  });
});

describe('parseCron', () => {
  it('expands a wildcard to the whole range', () => {
    const fields = parseCron('* * * * *');
    expect(fields?.minute.size).toBe(60);
    expect(fields?.hour.size).toBe(24);
    expect(fields?.domRestricted).toBe(false);
    expect(fields?.dowRestricted).toBe(false);
  });

  it('marks restricted day fields', () => {
    const fields = parseCron('0 0 13 * 5');
    expect(fields?.domRestricted).toBe(true);
    expect(fields?.dowRestricted).toBe(true);
    expect([...(fields?.dayOfWeek ?? [])]).toEqual([5]);
  });

  it('returns null for an unparseable expression', () => {
    expect(parseCron('nonsense')).toBeNull();
  });
});

describe('timezones', () => {
  // Every expected instant below was derived independently with Intl before the
  // implementation was asked anything — otherwise the test only asserts that
  // the code agrees with itself.
  //
  //   03:00 Berlin  = 01:00 UTC in summer (CEST), 02:00 UTC in winter (CET)
  //   09:00 Tokyo   = 00:00 UTC
  //   2027-03-28    Berlin has no 02:00-02:59 (clocks jump 02:00 -> 03:00)
  //   2026-10-25    Berlin has 02:30 twice (03:00 CEST -> 02:00 CET)

  it("reads the expression on the zone's wall clock, not on UTC", () => {
    expect(getNextRunTime('0 3 * * *', at('2026-07-01T12:00:00Z'), undefined, 'Europe/Berlin'))
      .toEqual(at('2026-07-02T01:00:00Z'));
  });

  it('keeps the same wall time when the offset changes with the season', () => {
    expect(getNextRunTime('0 3 * * *', at('2026-12-01T12:00:00Z'), undefined, 'Europe/Berlin'))
      .toEqual(at('2026-12-02T02:00:00Z'));
  });

  it('works east of UTC', () => {
    expect(getNextRunTime('0 9 * * *', at('2026-07-01T12:00:00Z'), undefined, 'Asia/Tokyo'))
      .toEqual(at('2026-07-02T00:00:00Z'));
  });

  it('is unchanged for UTC, which is what every existing row means', () => {
    expect(getNextRunTime('0 3 * * *', at('2026-07-01T12:00:00Z'), undefined, 'UTC'))
      .toEqual(at('2026-07-02T03:00:00Z'));
  });

  it("uses the zone's weekday, not the UTC one", () => {
    // 01:00 Monday in Auckland is still SUNDAY in UTC. A Monday-only job that
    // matched on the UTC weekday would fire on the wrong local day.
    const next = getNextRunTime('0 1 * * 1', at('2026-07-01T12:00:00Z'), undefined, 'Pacific/Auckland');
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Pacific/Auckland', weekday: 'long', hour: '2-digit', hourCycle: 'h23' }).format(next);
    expect(local).toMatch(/Monday/);
    expect(next.getUTCDay()).toBe(0); // Sunday in UTC — the point of the test
  });

  describe('daylight saving', () => {
    it('passes over a wall time that does not exist, instead of firing an hour early', () => {
      // Berlin jumps 02:00 -> 03:00 on 2027-03-28, so 02:30 never happens that
      // day. The job waits for the 29th rather than running at 03:30.
      expect(getNextRunTime('30 2 * * *', at('2027-03-27T12:00:00Z'), undefined, 'Europe/Berlin'))
        .toEqual(at('2027-03-29T00:30:00Z'));
    });

    it('fires at the first of a repeated wall time', () => {
      // Berlin repeats 02:00-02:59 on 2026-10-25. The first 02:30 is 00:30 UTC.
      expect(getNextRunTime('30 2 * * *', at('2026-10-24T12:00:00Z'), undefined, 'Europe/Berlin'))
        .toEqual(at('2026-10-25T00:30:00Z'));
    });

    it('still advances after the repeated hour rather than sticking', () => {
      const first = at('2026-10-25T00:30:00Z');
      const next = getNextRunTime('30 2 * * *', first, undefined, 'Europe/Berlin');
      expect(next.getTime()).toBeGreaterThan(first.getTime());
    });
  });

  it('falls back to UTC for a zone the runtime does not know, rather than going dormant', () => {
    // Dormant is the dangerous failure: a job that silently never runs.
    expect(getNextRunTime('0 3 * * *', at('2026-07-01T12:00:00Z'), undefined, 'Mars/Olympus_Mons'))
      .toEqual(at('2026-07-02T03:00:00Z'));
  });

  it('recognises real zones and rejects invented ones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});
