import { describe, it, expect } from 'vitest';
import { cronMatchesMinute, minuteStamp, cronMatchesMinuteInZone, makeZoneShifter } from './cron-match.js';

// is a Thursday (UTC).
const at = (h: number, m: number, day = 11, month = 6) =>
  new Date(Date.UTC(2026, month - 1, day, h, m, 30)); // :30s — must be ignored

describe('cronMatchesMinute', () => {
  it('* * * * * matches every minute', () => {
    expect(cronMatchesMinute('* * * * *', at(0, 0))).toBe(true);
    expect(cronMatchesMinute('* * * * *', at(23, 59))).toBe(true);
  });

  it('*/7 step semantics (minutes divisible by 7 from 0)', () => {
    expect(cronMatchesMinute('*/7 * * * *', at(10, 0))).toBe(true);
    expect(cronMatchesMinute('*/7 * * * *', at(10, 7))).toBe(true);
    expect(cronMatchesMinute('*/7 * * * *', at(10, 49))).toBe(true);
    expect(cronMatchesMinute('*/7 * * * *', at(10, 8))).toBe(false);
    expect(cronMatchesMinute('*/7 * * * *', at(10, 55))).toBe(false);
  });

  it('fixed daily schedule 0 3 * * *', () => {
    expect(cronMatchesMinute('0 3 * * *', at(3, 0))).toBe(true);
    expect(cronMatchesMinute('0 3 * * *', at(3, 1))).toBe(false);
    expect(cronMatchesMinute('0 3 * * *', at(4, 0))).toBe(false);
  });

  it('ranges, lists, range-steps', () => {
    expect(cronMatchesMinute('0-10 * * * *', at(9, 5))).toBe(true);
    expect(cronMatchesMinute('0-10 * * * *', at(9, 11))).toBe(false);
    expect(cronMatchesMinute('5,35 8-18 * * *', at(8, 35))).toBe(true);
    expect(cronMatchesMinute('5,35 8-18 * * *', at(19, 35))).toBe(false);
    expect(cronMatchesMinute('10-50/20 * * * *', at(0, 30))).toBe(true);  // 10,30,50
    expect(cronMatchesMinute('10-50/20 * * * *', at(0, 40))).toBe(false);
  });

  it('day-of-week incl Sunday alias 7 (2026-06-11 = Thursday=4, 2026-06-14 = Sunday)', () => {
    expect(cronMatchesMinute('0 0 * * 4', at(0, 0, 11))).toBe(true);
    expect(cronMatchesMinute('0 0 * * 0', at(0, 0, 14))).toBe(true);
    expect(cronMatchesMinute('0 0 * * 7', at(0, 0, 14))).toBe(true);
    expect(cronMatchesMinute('0 0 * * 1', at(0, 0, 11))).toBe(false);
  });

  it('POSIX OR rule when both DOM and DOW are restricted', () => {
    // is Thursday(4) and the 11th. DOM=11 OR DOW=Monday(1):
    expect(cronMatchesMinute('0 0 11 * 1', at(0, 0, 11))).toBe(true);   // DOM hits
    expect(cronMatchesMinute('0 0 12 * 4', at(0, 0, 11))).toBe(true);   // DOW hits
    expect(cronMatchesMinute('0 0 12 * 1', at(0, 0, 11))).toBe(false);  // neither
  });

  it('month restriction', () => {
    expect(cronMatchesMinute('0 0 1 1 *', at(0, 0, 1, 1))).toBe(true);
    expect(cronMatchesMinute('0 0 1 1 *', at(0, 0, 1, 6))).toBe(false);
  });

  it('never fires on malformed input (validator is the write gate; we fail closed)', () => {
    expect(cronMatchesMinute('every 2 minutes', at(0, 2))).toBe(false);
    expect(cronMatchesMinute('* * * *', at(0, 0))).toBe(false);
    expect(cronMatchesMinute('60 * * * *', at(0, 0))).toBe(false);
    expect(cronMatchesMinute('JAN * * * *', at(0, 0))).toBe(false);
  });
});

describe('minuteStamp', () => {
  it('formats UTC YYYYMMDDHHmm', () => {
    expect(minuteStamp(new Date(Date.UTC(2026, 5, 11, 3, 7, 59)))).toBe('202606110307');
  });
});

/**
 * Zone-aware matching.
 *
 * An operator types a wall-clock time. The platform stamps that same string
 * into every CronJob's `spec.timeZone`, so Kubernetes fires it in the
 * operator's zone — while the platform-side engines used to read it in UTC.
 * On a UTC+2 cluster that put the two halves two hours apart, which is how
 * `30 3 * * *` ended up running at 05:30 local.
 */
describe('cronMatchesMinuteInZone', () => {
  const CRON = '30 3 * * *';

  it('fires at the zone\'s wall clock, not UTC', () => {
    // 03:30 in Africa/Windhoek (UTC+2, no DST) is 01:30 UTC.
    expect(cronMatchesMinuteInZone(CRON, new Date('2026-09-23T01:30:00Z'), 'Africa/Windhoek')).toBe(true);
    // 03:30 UTC is 05:30 local — the old behaviour, now explicitly NOT a match.
    expect(cronMatchesMinuteInZone(CRON, new Date('2026-09-23T03:30:00Z'), 'Africa/Windhoek')).toBe(false);
  });

  it('is identical to the UTC matcher when the zone IS UTC', () => {
    for (const z of ['UTC', 'Etc/UTC', null]) {
      expect(cronMatchesMinuteInZone(CRON, new Date('2026-09-23T03:30:00Z'), z)).toBe(true);
      expect(cronMatchesMinuteInZone(CRON, new Date('2026-09-23T01:30:00Z'), z)).toBe(false);
    }
  });

  it('follows DST rather than applying a fixed offset', () => {
    // Europe/Berlin is UTC+2 in summer, UTC+1 in winter. Same cron string,
    // same wall-clock intent, two different UTC instants.
    expect(cronMatchesMinuteInZone(CRON, new Date('2026-07-15T01:30:00Z'), 'Europe/Berlin')).toBe(true);
    expect(cronMatchesMinuteInZone(CRON, new Date('2026-07-15T02:30:00Z'), 'Europe/Berlin')).toBe(false);
    expect(cronMatchesMinuteInZone(CRON, new Date('2026-12-15T02:30:00Z'), 'Europe/Berlin')).toBe(true);
    expect(cronMatchesMinuteInZone(CRON, new Date('2026-12-15T01:30:00Z'), 'Europe/Berlin')).toBe(false);
  });

  it('shifts the DATE fields too, not just the clock', () => {
    // 23:30 UTC on the 22nd is 01:30 on the 23rd in Windhoek. A day-of-month
    // cron must see the 23rd — shifting only hours/minutes would fire a
    // monthly backup on the wrong day.
    expect(cronMatchesMinuteInZone('30 1 23 * *', new Date('2026-09-22T23:30:00Z'), 'Africa/Windhoek')).toBe(true);
    expect(cronMatchesMinuteInZone('30 1 22 * *', new Date('2026-09-22T23:30:00Z'), 'Africa/Windhoek')).toBe(false);
  });

  it('shifts day-of-week too', () => {
    // The instant below is a Tuesday in UTC but already Wednesday (3) in
    // Windhoek — a day-of-week cron must see the LOCAL day.
    expect(cronMatchesMinuteInZone('30 1 * * 3', new Date('2026-09-22T23:30:00Z'), 'Africa/Windhoek')).toBe(true);
    expect(cronMatchesMinuteInZone('30 1 * * 2', new Date('2026-09-22T23:30:00Z'), 'Africa/Windhoek')).toBe(false);
  });

  it('treats an unparseable zone as UTC instead of throwing', () => {
    // One bad zone string must not stop every schedule on the cluster. It
    // degrades to the previous behaviour, loudly wrong rather than silent.
    expect(cronMatchesMinuteInZone(CRON, new Date('2026-09-23T03:30:00Z'), 'Not/AZone')).toBe(true);
  });

  it('still rejects a malformed cron regardless of zone', () => {
    expect(cronMatchesMinuteInZone('nonsense', new Date('2026-09-23T01:30:00Z'), 'Africa/Windhoek')).toBe(false);
    expect(cronMatchesMinuteInZone('30 3 * *', new Date('2026-09-23T01:30:00Z'), 'Africa/Windhoek')).toBe(false);
  });
});

describe('makeZoneShifter', () => {
  it('returns a Date whose UTC fields read as the zone wall clock', () => {
    const shift = makeZoneShifter('Africa/Windhoek');
    const d = shift(new Date('2026-09-23T01:30:00Z').getTime());
    expect(d.getUTCHours()).toBe(3);
    expect(d.getUTCMinutes()).toBe(30);
  });

  it('caches per UTC hour but still re-resolves across a DST boundary', () => {
    const shift = makeZoneShifter('Europe/Berlin');
    // Late October 2026: CEST (+2) before the switch, CET (+1) after.
    expect(shift(new Date('2026-10-20T12:00:00Z').getTime()).getUTCHours()).toBe(14);
    expect(shift(new Date('2026-11-20T12:00:00Z').getTime()).getUTCHours()).toBe(13);
  });

  it('is a pass-through for UTC', () => {
    for (const z of [null, 'UTC', 'Etc/UTC']) {
      const shift = makeZoneShifter(z);
      const ms = new Date('2026-09-23T01:30:00Z').getTime();
      expect(shift(ms).getTime()).toBe(ms);
    }
  });
});
