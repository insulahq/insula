/**
 * How old a database's last good backup may be before it counts as stale.
 *
 * Derived from the tenant-bundle schedule, never a fixed number of hours: the
 * longest gap between two consecutive fires of `backup_schedules.tenant_bundle`
 * (read in the platform's time zone), plus a grace for the nightly wave to
 * reach every tenant. A daily cron gives 26 h; a weekday-only one is not
 * called stale over the weekend; a weekly one waits a week.
 */

import { cronMatchesMinute, makeZoneShifter } from '../../shared/cron-match.js';

/** Time for the wave, which bundles tenants one at a time, to reach every tenant. */
export const STALE_GRACE_MS = 2 * 3_600_000;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** First scan: a week and a day covers every daily and weekly schedule. */
const SHORT_SCAN_DAYS = 8;
/** Fallback for a schedule that fires less often: two months shows a monthly one twice. */
const LONG_SCAN_DAYS = 62;

/** The fire instants of `cron` in [from, from + days), read in `timeZone`. */
function fires(cron: string, timeZone: string | null, from: Date, days: number): number[] {
  const shift = makeZoneShifter(timeZone);
  const start = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS;
  const end = start + days * DAY_MS;
  const out: number[] = [];
  for (let t = start; t < end; t += MINUTE_MS) {
    if (cronMatchesMinute(cron, shift(t))) out.push(t);
  }
  return out;
}

/** Longest gap between consecutive fires, or the scan length when it fired once; null when never. */
function longestGapMs(at: readonly number[], scanDays: number): number | null {
  if (at.length === 0) return null;
  if (at.length === 1) return scanDays * DAY_MS;
  let max = 0;
  for (let i = 1; i < at.length; i++) max = Math.max(max, at[i]! - at[i - 1]!);
  return max;
}

/**
 * The stale threshold in ms for the schedule `cron`, or null when the
 * schedule never fires (no backups are expected, so nothing can be late).
 */
export function staleThresholdMs(cron: string | null | undefined, timeZone: string | null, now: Date): number | null {
  if (!cron || cron.trim() === '') return null;
  let gap = longestGapMs(fires(cron, timeZone, now, SHORT_SCAN_DAYS), SHORT_SCAN_DAYS);
  if (gap === null || gap >= SHORT_SCAN_DAYS * DAY_MS) {
    gap = longestGapMs(fires(cron, timeZone, now, LONG_SCAN_DAYS), LONG_SCAN_DAYS);
  }
  return gap === null ? null : gap + STALE_GRACE_MS;
}
