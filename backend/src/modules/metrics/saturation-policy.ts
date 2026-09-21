/**
 * Saturation episode policy — pure decisions, no database, no clock of its own.
 *
 * Split out of `tenant-saturation.ts` so the part that decides WHETHER to
 * speak can be tested without a cluster, a scheduler, or a Postgres. The part
 * that decides whether this REPLICA gets to speak lives in the SQL claim; see
 * `tenant-saturation.ts`.
 *
 * The model is an episode, not a sample. A tenant sitting at 94% of its
 * storage is one ongoing situation that begins, may escalate, and ends — not
 * 24 independent daily facts, which is what the hour-bucketed dedupe key this
 * replaces turned it into.
 */

export type SaturationLevel = 'warning' | 'critical';

/** CPU/memory: warn at 90% of allocation, critical at/over 100% (throttle/OOM). */
export const SATURATION_WARN = 0.9;
export const SATURATION_CRITICAL = 1.0;
/** Storage can't cleanly reach 100% (fs reserve), so critical is 95%. */
export const STORAGE_SATURATION_CRITICAL = 0.95;

/**
 * How far usage must fall below a boundary before the episode steps down,
 * as a fraction of the limit. 5 points: a tenant parked on 90.0% would
 * otherwise open and resolve an episode on alternate cycles, which is a worse
 * inbox than the hourly repeat this replaces.
 */
export const HYSTERESIS = 0.05;

/**
 * Reminder backoff for a SUSTAINED episode, indexed by how many notifications
 * it has already produced. The opening alert is index 0, so the first reminder
 * lands an hour later, the second six hours after that, and every one after
 * that is daily.
 *
 * A flat 24h (what node-health and the capacity reconciler use) is too coarse
 * at the top of the ladder: a disk filling in an afternoon deserves a second
 * word before tomorrow. A flat 1h is the bug being fixed.
 */
export const REMINDER_LADDER_MS: readonly number[] = [
  1 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

/** Delay owed before the next reminder, given how many have already gone out. */
export function reminderDelayMs(notifyCount: number): number {
  const i = Math.max(0, Math.floor(notifyCount) - 1);
  return REMINDER_LADDER_MS[Math.min(i, REMINDER_LADDER_MS.length - 1)];
}

/** Pure: usage ratio + thresholds → severity, with no memory of the past. */
export function saturationLevel(
  ratio: number,
  warn: number,
  crit: number,
): SaturationLevel | null {
  if (!Number.isFinite(ratio) || ratio < warn) return null;
  return ratio >= crit ? 'critical' : 'warning';
}

/**
 * The level this episode should now be at, given where it already is.
 *
 * Entering a band uses the hard threshold; LEAVING one requires falling a
 * further `hysteresis` below it. Escalation is deliberately exempt — bad news
 * is never delayed, only good news has to prove itself.
 */
export function levelWithHysteresis(
  ratio: number,
  prev: SaturationLevel | null,
  warn: number,
  crit: number,
  hysteresis: number = HYSTERESIS,
): SaturationLevel | null {
  if (!Number.isFinite(ratio)) return null;
  if (ratio >= crit) return 'critical';
  if (prev === 'critical') {
    if (ratio >= crit - hysteresis) return 'critical';
    // Stepped out of critical — judge the warning band, itself sticky
    // because we are still inside an open episode.
    return ratio >= warn - hysteresis ? 'warning' : null;
  }
  if (ratio >= warn) return 'warning';
  if (prev === 'warning') return ratio >= warn - hysteresis ? 'warning' : null;
  return null;
}

/**
 * `open`      no episode was running and the condition is now met
 * `escalate`  a running episode changed level (either direction)
 * `remind`    unchanged, and the ladder says it is time to say so again
 * `resolve`   the condition cleared — send the all-clear, close the episode
 * `none`      nothing to say
 */
export type EpisodeAction = 'open' | 'escalate' | 'remind' | 'resolve' | 'none';

export function decideEpisodeAction(input: {
  readonly newLevel: SaturationLevel | null;
  readonly prevLevel: SaturationLevel | null;
  readonly lastNotifiedAt: Date | null;
  readonly notifyCount: number;
  readonly now: Date;
}): EpisodeAction {
  const { newLevel, prevLevel, lastNotifiedAt, notifyCount, now } = input;
  if (prevLevel === null) return newLevel === null ? 'none' : 'open';
  if (newLevel === null) return 'resolve';
  if (newLevel !== prevLevel) return 'escalate';
  // A row with no usable timestamp is treated as due rather than never due —
  // the failure mode of the alternative is silence, which is the one outcome
  // an alerting path must not have. See the `now`-based deadline that never
  // arrived in the cron scheduler.
  if (lastNotifiedAt === null || Number.isNaN(lastNotifiedAt.getTime())) return 'remind';
  return now.getTime() - lastNotifiedAt.getTime() >= reminderDelayMs(notifyCount)
    ? 'remind'
    : 'none';
}

/** "3 hours", "2 days" — how long an episode ran, for the all-clear message. */
export function durationText(fromMs: number, toMs: number): string {
  const ms = Math.max(0, toMs - fromMs);
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(ms / 3600000);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(ms / 86400000);
  return `${days} day${days === 1 ? '' : 's'}`;
}
