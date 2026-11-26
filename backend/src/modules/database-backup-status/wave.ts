/**
 * Which scheduled run a database's backups are judged against.
 *
 * A database is overdue when it had no good backup in the latest scheduled
 * tenant-bundle run that has had time to finish. Judging against the run —
 * not against "N hours since the last good backup" — is what makes the answer
 * independent of where a tenant falls in the wave: the wave bundles tenants
 * one at a time in no promised order, so a tenant done first one night and
 * last the next goes far more than 24 hours between good backups without
 * missing a single run. A fixed 26 hours called that tenant overdue, and
 * then recovered, the same night.
 *
 * "Had time to finish": the run's fire time plus the measured length of the
 * last completed wave and an hour, never less than two hours. A run whose wave
 * is still in progress is never the judged one. Fire times are read in the
 * platform's time zone, so daylight-saving changes move them like the
 * scheduler does.
 */

import { cronMatchesMinute, makeZoneShifter } from '../../shared/cron-match.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The least a wave is given to finish. */
export const MIN_WAVE_ALLOWANCE_MS = 2 * HOUR_MS;
/** Added to the measured length of the last completed wave. */
export const WAVE_MARGIN_MS = HOUR_MS;
/** How far back a run is looked for: two months shows a monthly schedule. */
const LOOKBACK_DAYS = 62;

/**
 * The fire instants of `cron` at or before `atOrBefore`, newest first, at most
 * `count` of them, looking back at most LOOKBACK_DAYS.
 */
export function runsAtOrBefore(cron: string, timeZone: string | null, atOrBefore: Date, count: number): Date[] {
  const shift = makeZoneShifter(timeZone);
  const out: Date[] = [];
  const end = Math.floor(atOrBefore.getTime() / MINUTE_MS) * MINUTE_MS;
  const stop = end - LOOKBACK_DAYS * DAY_MS;
  for (let t = end; t >= stop && out.length < count; t -= MINUTE_MS) {
    if (cronMatchesMinute(cron, shift(t))) out.push(new Date(t));
  }
  return out;
}

/** How long a wave is given to finish: the last completed one's length plus a margin. */
export function waveAllowanceMs(lastCompletedWaveMs: number | null): number {
  if (lastCompletedWaveMs === null || !Number.isFinite(lastCompletedWaveMs) || lastCompletedWaveMs < 0) {
    return MIN_WAVE_ALLOWANCE_MS;
  }
  return Math.max(MIN_WAVE_ALLOWANCE_MS, lastCompletedWaveMs + WAVE_MARGIN_MS);
}

/**
 * The run databases are judged against, or null when there is none (no
 * schedule, or it has not fired in two months). `runningWaveFiredAt` is the
 * fire time of a wave still in progress, if any: that run and later ones are
 * not judged yet. `lastFiredAt` is the latest run the scheduler actually
 * claimed: a run the cron names but that never fired (the schedule was off
 * at the time, or was enabled after it) is not judged — a database cannot
 * have missed a backup run that did not happen. Null: nothing has fired.
 */
export function judgedRun(
  cron: string | null | undefined,
  timeZone: string | null,
  now: Date,
  allowanceMs: number,
  runningWaveFiredAt: Date | null = null,
  lastFiredAt: Date | null = now,
): Date | null {
  if (!cron || cron.trim() === '' || !lastFiredAt) return null;
  let latest = new Date(Math.min(now.getTime() - allowanceMs, lastFiredAt.getTime()));
  if (runningWaveFiredAt && runningWaveFiredAt.getTime() <= latest.getTime()) {
    latest = new Date(runningWaveFiredAt.getTime() - MINUTE_MS);
  }
  return runsAtOrBefore(cron, timeZone, latest, 1)[0] ?? null;
}
