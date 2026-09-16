import { describe, it, expect } from 'vitest';
import { getNextRunTime, parseCron, NEVER } from './cron-expression.js';

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

  describe('a job that has never run', () => {
    it('waits for its next scheduled minute instead of firing immediately', () => {
      // The old implementation used the epoch as the base, so every new job was
      // "due" the moment it was saved, whatever its schedule said.
      const now = at('2026-09-16T12:00:00Z');
      expect(getNextRunTime('0 3 * * *', null, now)).toEqual(at('2026-09-17T03:00:00Z'));
    });

    it('still starts within a minute for * * * * *', () => {
      const now = at('2026-09-16T12:00:30Z');
      expect(getNextRunTime('* * * * *', null, now)).toEqual(at('2026-09-16T12:01:00Z'));
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
