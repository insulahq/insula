import { describe, it, expect } from 'vitest';
import { cronMatchesMinute, minuteStamp } from './cron-match.js';

// 2026-06-11 is a Thursday (UTC).
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
    // 2026-06-11 is Thursday(4) and the 11th. DOM=11 OR DOW=Monday(1):
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
