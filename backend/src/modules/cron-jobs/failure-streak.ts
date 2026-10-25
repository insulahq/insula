/**
 * When a failing cron job is worth telling anyone about.
 *
 * Production, four weeks: 41 failure notices, nearly all for a single run
 * followed by one that worked — a pod restarted under a Moodle cron, a
 * storage failover, a Nextcloud webcron whose one slow background job came
 * round once a day. Each told the tenant their task had failed; none needed
 * anything done.
 *
 * So a job that runs again within the hour is reported once two runs in a row
 * have failed. A real breakage still reaches them, one run later — at most an
 * hour. A job whose next run is further away reports its first failure:
 * waiting for a second would hold a broken nightly job back by a day.
 *
 * The streak counts the tenant's own failures only. A run the platform could
 * not start, or stopped, neither adds to it nor clears it (scheduler.ts).
 */
import { getNextRunTime } from './cron-expression.js';

/** A job whose next run comes within this long waits for a second failure. */
export const FREQUENT_JOB_MAX_GAP_MS = 60 * 60_000;

/** Failed runs in a row before a frequent job is reported. */
export const FREQUENT_JOB_FAILURES_BEFORE_NOTICE = 2;

/**
 * How many failed runs in a row this job needs before anyone is told: 2 when
 * its next run, counted from `after`, is within the hour, else 1. Read from
 * the next run rather than the schedule's shape, so a job that runs every
 * five minutes from 9 to 17 and fails at 17:55 reports at once — its next run
 * is the next morning. Pure.
 */
export function failuresBeforeNotice(schedule: string, after: Date, timeZone: string): number {
  const next = getNextRunTime(schedule, after, after, timeZone);
  return next.getTime() - after.getTime() <= FREQUENT_JOB_MAX_GAP_MS
    ? FREQUENT_JOB_FAILURES_BEFORE_NOTICE
    : 1;
}

/** Has this failure streak reached the point where the tenant is told? Pure. */
export function failureIsReportable(
  streak: number,
  schedule: string,
  after: Date,
  timeZone: string,
): boolean {
  return streak >= failuresBeforeNotice(schedule, after, timeZone);
}
