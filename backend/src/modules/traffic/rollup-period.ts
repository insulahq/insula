/**
 * The buckets a range past metric retention is drawn in.
 *
 * Rollup rows are hourly for 30 days, daily for a year, monthly for five. A
 * range is drawn at the coarsest resolution any part of it still has: one
 * point per UTC day while it starts within a year, one per UTC month when it
 * reaches further back. Drawing a year-old month as thirty daily points would
 * put the whole month on its first day.
 */

import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { buildTimeline } from './frame.js';

export type RollupPeriod = 'daily' | 'monthly';

const DAY_MS = 86_400_000;
/** The daily rows are kept this long; a range starting further back is monthly. */
export const DAILY_ROLLUP_DAYS = 365;
/** Same grace as at the 30-day edge: a "Last 12 months" computed in the browser lands a moment past it. */
const EDGE_GRACE_MS = 3_600_000;
/**
 * A monthly point's step: the mean Gregorian month. Points are rates, and the
 * panel totals a range as Σ point × step, so a month's bytes ÷ this step add
 * back up to exactly the month's bytes whatever the month's length.
 */
export const MONTH_STEP_SECONDS = 2_629_746;

export function periodFor(from: Date, now: Date): RollupPeriod {
  return from.getTime() < now.getTime() - DAILY_ROLLUP_DAYS * DAY_MS - EDGE_GRACE_MS ? 'monthly' : 'daily';
}

export function periodStepSeconds(period: RollupPeriod): number {
  return period === 'daily' ? 86_400 : MONTH_STEP_SECONDS;
}

/** UTC start of the month containing `ms`. */
function monthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** First instant after the bucket starting at `start`. */
export function periodEnd(period: RollupPeriod, start: number): number {
  if (period === 'daily') return start + DAY_MS;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Bucket starts from the first one at or after `fromMs` to the last one at or
 * before `toMs`. A partial first bucket is left out, as `buildTimeline` does
 * for days: its rows before `from` are not read, so it could only draw short.
 */
export function periodTimeline(period: RollupPeriod, fromMs: number, toMs: number): number[] {
  if (period === 'daily') return buildTimeline(fromMs, toMs, 86_400);
  const out: number[] = [];
  let t = monthStart(fromMs) === fromMs ? fromMs : periodEnd('monthly', monthStart(fromMs));
  for (; t <= toMs; t = periodEnd('monthly', t)) out.push(t);
  return out;
}

/**
 * SQL for the start (epoch milliseconds) of the bucket a stored timestamp
 * falls in. The columns are UTC without a zone, so epoch arithmetic and
 * `date_trunc` both work in UTC.
 */
export function periodBucketSql(period: RollupPeriod, column: AnyColumn | SQL): SQL<number> {
  return period === 'daily'
    ? sql<number>`(floor(extract(epoch from ${column}) / 86400) * 86400000)::bigint`
    : sql<number>`(extract(epoch from date_trunc('month', ${column})) * 1000)::bigint`;
}
