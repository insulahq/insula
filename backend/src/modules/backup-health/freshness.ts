/**
 * Backup FRESHNESS — is a repo still receiving backups on its schedule?
 *
 * Every existing health signal answers a different question. "The Job failed" is
 * caught by the Job watcher. "The repo is reachable" is answered by a listing
 * that runs `--no-lock` and therefore reads a wedged repo happily. "A snapshot
 * exists" is answered by `lastSnapshotAt`, which nothing ever compares to the
 * schedule that was supposed to produce the next one.
 *
 * So the state that actually hurt — DEV, 2026-09-15: last successful mail
 * snapshot 2026-09-11T19:31, 178 scheduled fires missed, every operator surface
 * green — had no detector at all. This is that detector.
 *
 * Counting MISSED FIRES rather than elapsed time is deliberate. A repo on
 * `0 3 * * 1-5` is perfectly healthy 60 hours after its last run if those hours
 * were a weekend; one on `*\/30 * * * *` is in trouble after 3. Elapsed time
 * cannot tell those apart, and a per-schedule threshold is one more thing to
 * configure wrong.
 */
import { cronMatchesMinute } from '../../shared/cron-match.js';

export type FreshnessVerdict = 'fresh' | 'stale' | 'never' | 'unknown';

/** Consecutive missed fires before a repo is called stale. */
export const DEFAULT_STALE_AFTER_FIRES = 3;

/**
 * Never scan further back than this. A gap this large is unambiguously stale,
 * and iterating minute-by-minute across it buys nothing but CPU.
 */
export const MAX_SCAN_DAYS = 45;

const MINUTE_MS = 60_000;

export interface FreshnessInput {
  /** Completion time of the most recent SUCCESSFUL run. null = never ran. */
  readonly lastSuccessAt: Date | null;
  /** The 5-field cron the runs are scheduled on. null/invalid ⇒ 'unknown'. */
  readonly cronExpression: string | null;
  readonly now: Date;
  readonly staleAfterFires?: number;
  /**
   * The verdict from the previous evaluation, if any.
   *
   * Between 1 missed fire and the stale threshold the verdict HOLDS rather than
   * flipping. Without that band a schedule whose runs land a minute either side
   * of the boundary oscillates fresh→stale→fresh, and an alert that flaps is an
   * alert that gets muted.
   */
  readonly previous?: FreshnessVerdict;
  /** CronJob `spec.timeZone`. Null/absent = UTC, which is the k8s default. */
  readonly timeZone?: string | null;
}

export interface FreshnessResult {
  readonly verdict: FreshnessVerdict;
  /** Scheduled fires since the last success, saturating at the scan cap. */
  readonly missedFires: number;
  /** Milliseconds since the last success; null when there has never been one. */
  readonly ageMs: number | null;
  /** Operator-facing one-liner. Always populated. */
  readonly detail: string;
}

/**
 * Count scheduled fires in (from, to]. Saturates rather than running unbounded.
 *
 * Exported for tests: the counting is the part that decides whether a real
 * outage is seen, so it is worth pinning independently of the verdict logic.
 */
export function countScheduledFires(
  cronExpression: string,
  from: Date,
  to: Date,
  maxScanDays = MAX_SCAN_DAYS,
  /**
   * The CronJob's `spec.timeZone`. Kubernetes fires the schedule in THIS zone,
   * so counting in UTC mis-counts by the offset on any cluster that sets it —
   * a `0 3 * * *` job in Europe/Berlin fires at 01:00/02:00 UTC. That shows up
   * as phantom missed fires (a false "backups have stopped") or, in the other
   * direction, as a real outage that stays invisible. Null/UTC = no shift.
   */
  timeZone: string | null = null,
): number {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) return 0;
  if (to.getTime() <= from.getTime()) return 0;

  const capMs = maxScanDays * 24 * 60 * MINUTE_MS;
  const start = to.getTime() - from.getTime() > capMs
    ? new Date(to.getTime() - capMs)
    : from;

  // Step to the start of the minute AFTER `start`: a fire at the same minute as
  // the last success is the run that produced it, not a missed one.
  let cursor = Math.floor(start.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const end = to.getTime();
  const zoned = makeZoneShifter(timeZone);
  let count = 0;
  while (cursor <= end) {
    if (cronMatchesMinute(cronExpression, zoned(cursor))) count += 1;
    cursor += MINUTE_MS;
  }
  return count;
}

/**
 * Offset, in ms, between UTC and `timeZone` at a given instant.
 *
 * DST-correct because Intl resolves the zone AT that instant rather than
 * applying a fixed offset. Unknown zone → 0, i.e. UTC: a single bad
 * `spec.timeZone` must not take the whole sweep down. Same
 * formatToParts approach as preferences/quiet-hours.ts — built-in, no
 * luxon/date-fns-tz dependency.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const get = (t: string): number =>
      Number.parseInt(parts.find((x) => x.type === t)?.value ?? '0', 10);
    const hour = get('hour') === 24 ? 0 : get('hour');
    const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
    return asIfUtc - at.getTime();
  } catch {
    return 0;
  }
}

/**
 * Minute-stepping is cheap; Intl is not. The offset can only change at a DST
 * boundary, so resolving it once per UTC hour is exact and ~1000 lookups for a
 * full 45-day scan instead of ~65,000.
 */
function makeZoneShifter(timeZone: string | null): (utcMs: number) => Date {
  if (!timeZone || timeZone === 'UTC' || timeZone === 'Etc/UTC') {
    return (utcMs) => new Date(utcMs);
  }
  let cachedHour = Number.NaN;
  let offset = 0;
  return (utcMs) => {
    const hour = Math.floor(utcMs / 3_600_000);
    if (hour !== cachedHour) {
      cachedHour = hour;
      offset = zoneOffsetMs(new Date(utcMs), timeZone);
    }
    // A Date whose UTC fields read as the zone's wall clock, which is what the
    // UTC-based matcher needs to see.
    return new Date(utcMs + offset);
  };
}

/** Is this a 5-field expression `cronMatchesMinute` can actually evaluate? */
function isEvaluableCron(expr: string): boolean {
  if (expr.trim().split(/\s+/).length !== 5) return false;
  // cronMatchesMinute returns false for BOTH "does not fire now" and "cannot
  // parse", so probing one minute cannot distinguish them. Scan a full day: a
  // valid expression fires at least once a day unless it is date-restricted, and
  // a month covers those.
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < 44_640; i += 1) {
    if (cronMatchesMinute(expr, new Date(base + i * MINUTE_MS))) return true;
  }
  return false;
}

export function evaluateFreshness(input: FreshnessInput): FreshnessResult {
  const staleAfter = input.staleAfterFires ?? DEFAULT_STALE_AFTER_FIRES;

  if (!input.cronExpression || !isEvaluableCron(input.cronExpression)) {
    return {
      verdict: 'unknown',
      missedFires: 0,
      ageMs: input.lastSuccessAt ? input.now.getTime() - input.lastSuccessAt.getTime() : null,
      detail: input.cronExpression
        ? `Schedule '${input.cronExpression}' is not a parseable 5-field cron — freshness cannot be judged.`
        : 'No schedule configured — freshness cannot be judged.',
    };
  }

  if (!input.lastSuccessAt) {
    return {
      verdict: 'never',
      missedFires: 0,
      ageMs: null,
      // Distinct from 'stale' on purpose: a repo that has NEVER produced a
      // backup is a setup problem, and telling an operator it "went stale"
      // sends them looking for a regression that never existed.
      detail: 'No successful run has ever been recorded for this schedule.',
    };
  }

  const ageMs = input.now.getTime() - input.lastSuccessAt.getTime();
  const missedFires = countScheduledFires(
    input.cronExpression, input.lastSuccessAt, input.now, MAX_SCAN_DAYS, input.timeZone ?? null,
  );

  const hours = (ageMs / 3_600_000).toFixed(1);
  if (missedFires === 0) {
    return {
      verdict: 'fresh',
      missedFires,
      ageMs,
      detail: `Last successful run ${hours}h ago; no scheduled run has been missed.`,
    };
  }

  if (missedFires >= staleAfter) {
    return {
      verdict: 'stale',
      missedFires,
      ageMs,
      detail: `${missedFires} scheduled run(s) missed since the last success ${hours}h ago.`,
    };
  }

  // Inside the hysteresis band: hold rather than flap.
  const held = input.previous ?? 'fresh';
  return {
    verdict: held === 'never' ? 'stale' : held,
    missedFires,
    ageMs,
    detail: `${missedFires} scheduled run(s) missed since the last success ${hours}h ago `
      + `(below the ${staleAfter}-miss threshold; holding '${held}').`,
  };
}
