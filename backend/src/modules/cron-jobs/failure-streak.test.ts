import { describe, it, expect } from 'vitest';
import { failuresBeforeNotice, failureIsReportable } from './failure-streak.js';

describe('failuresBeforeNotice', () => {
  const at = new Date('2026-10-25T10:00:30Z');

  it('waits for a second failure from a job that runs again within the hour', () => {
    expect(failuresBeforeNotice('* * * * *', at, 'UTC')).toBe(2);
    expect(failuresBeforeNotice('*/5 * * * *', at, 'UTC')).toBe(2);
    expect(failuresBeforeNotice('*/15 * * * *', at, 'UTC')).toBe(2);
  });

  it('counts an hourly job as frequent — its next run is never more than an hour off', () => {
    expect(failuresBeforeNotice('0 * * * *', at, 'UTC')).toBe(2);
    expect(failuresBeforeNotice('52 * * * *', new Date('2026-10-25T10:52:01Z'), 'UTC')).toBe(2);
  });

  it('reports a nightly or weekly job on its first failure', () => {
    expect(failuresBeforeNotice('0 3 * * *', at, 'UTC')).toBe(1);
    expect(failuresBeforeNotice('0 22 * * 5', at, 'UTC')).toBe(1);
    expect(failuresBeforeNotice('0 */2 * * *', at, 'UTC')).toBe(1);
  });

  it('reads the gap to the NEXT run, not the schedule — the last run of a working day reports at once', () => {
    const businessHours = '*/5 9-17 * * *';
    expect(failuresBeforeNotice(businessHours, new Date('2026-10-25T12:00:10Z'), 'UTC')).toBe(2);
    expect(failuresBeforeNotice(businessHours, new Date('2026-10-25T17:55:10Z'), 'UTC')).toBe(1);
  });

  it('reads the gap on the job\'s own clock', () => {
    // 17:55 UTC is 19:55 in Johannesburg: outside 9-17 there, the next run is tomorrow.
    expect(failuresBeforeNotice('*/5 9-17 * * *', new Date('2026-10-25T13:00:10Z'), 'Africa/Johannesburg')).toBe(2);
    expect(failuresBeforeNotice('*/5 9-17 * * *', new Date('2026-10-25T15:58:10Z'), 'Africa/Johannesburg')).toBe(1);
  });

  it('an unparseable schedule, which never runs again, reports its first failure', () => {
    expect(failuresBeforeNotice('not a schedule', at, 'UTC')).toBe(1);
  });
});

describe('failureIsReportable', () => {
  const at = new Date('2026-10-25T10:00:30Z');

  it('is false for the first failure of a frequent job, true from the second', () => {
    expect(failureIsReportable(1, '* * * * *', at, 'UTC')).toBe(false);
    expect(failureIsReportable(2, '* * * * *', at, 'UTC')).toBe(true);
    expect(failureIsReportable(7, '* * * * *', at, 'UTC')).toBe(true);
  });

  it('is true for the first failure of a daily job', () => {
    expect(failureIsReportable(1, '0 3 * * *', at, 'UTC')).toBe(true);
  });

  it('is false when nothing has failed', () => {
    expect(failureIsReportable(0, '0 3 * * *', at, 'UTC')).toBe(false);
  });
});
