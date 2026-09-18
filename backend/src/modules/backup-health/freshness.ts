/**
 * Backup FRESHNESS — is a repo still receiving backups on its schedule?
 *
 * Every existing health signal answers a different question. "The Job failed" is
 * caught by the Job watcher. "The repo is reachable" is answered by a listing
 * that runs `--no-lock` and therefore reads a wedged repo happily. "A snapshot
 * exists" is answered by `lastSnapshotAt`, which nothing ever compares to the
 * schedule that was supposed to produce the next one.
 *
 * So the state that actually hurt — DEV: last successful mail
 * snapshot -11T19:31, 178 scheduled fires missed, every operator surface
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

/**
 * Ceiling on the proportional grace.
 *
 * Half an interval is the right SHAPE — it stops a half-hourly schedule
 * flapping — but as an absolute it is far too generous at the long end: half a
 * day of silence on a daily backup, half a week on a weekly one. The operator
 * point that forced this: on `0 3 * * *` the failure is knowable at 03:00 and
 * a half-interval grace sits on it until 15:00, which overnight is most of the
 * window to fix it before the next attempt.
 *
 * The grace only has to absorb SCHEDULING lag now, not run duration — a run
 * that is genuinely in progress is excluded by `status.active` in the sweep,
 * and the observed durations on the watched CronJobs are seconds to minutes
 * (6s, 58s, 3m30s). An hour is generous against that.
 *
 *   half-hourly  grace 15m  -> reported 45m after the last success
 *   hourly       grace 30m  -> 1.5h
 *   daily        grace  1h  -> 04:00, i.e. 25h (was 36h)
 *   weekly       grace  1h  -> 7d 1h (was 10.5d)
 */
export const MAX_STALE_GRACE_MS = 60 * 60_000;

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
export interface FireScan {
  /** Scheduled fires in (from, to], saturating at the scan cap. */
  readonly count: number;
  /** The FIRST scheduled fire after `from` — i.e. the run that should have happened. */
  readonly firstFireAt: Date | null;
  /** Gap between consecutive fires, for scaling the grace to the schedule. */
  readonly intervalMs: number | null;
}

/**
 * Like countScheduledFires, but also reports WHEN the first missed run was due
 * and how far apart runs are.
 *
 * Both are needed to make lateness proportional. A fixed "3 missed fires"
 * threshold means silence for three whole periods, which on a daily backup is
 * three DAYS — almost exactly the outage this detector was built for (DEV went
 * 3d 17h unreported). The same threshold on a half-hourly schedule is 90
 * minutes.
 * One number cannot serve both.
 */
export function scanScheduledFires(
  cronExpression: string,
  from: Date,
  to: Date,
  maxScanDays = MAX_SCAN_DAYS,
  timeZone: string | null = null,
): FireScan {
  const empty: FireScan = { count: 0, firstFireAt: null, intervalMs: null };
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) return empty;

  const capMs = maxScanDays * 24 * 60 * MINUTE_MS;
  const start = to.getTime() - from.getTime() > capMs
    ? new Date(to.getTime() - capMs)
    : from;

  const zoned = makeZoneShifter(timeZone);
  let cursor = Math.floor(start.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const end = to.getTime();
  // Keep scanning past `to` purely to find fire #2, so the interval is known
  // even when only one run has been missed so far — which is the case the
  // proportional grace exists to handle.
  const hardStop = Math.max(end, start.getTime() + capMs);

  let count = 0;
  let first: number | null = null;
  let second: number | null = null;
  while (cursor <= hardStop) {
    if (cronMatchesMinute(cronExpression, zoned(cursor))) {
      if (cursor <= end) count += 1;
      if (first === null) first = cursor;
      else if (second === null) { second = cursor; if (cursor > end) break; }
    }
    cursor += MINUTE_MS;
  }

  return {
    count,
    firstFireAt: first === null ? null : new Date(first),
    intervalMs: first !== null && second !== null ? second - first : null,
  };
}

export function countScheduledFires(
  cronExpression: string,
  from: Date,
  to: Date,
  maxScanDays = MAX_SCAN_DAYS,
  timeZone: string | null = null,
): number {
  if (to.getTime() <= from.getTime()) return 0;
  return scanScheduledFires(cronExpression, from, to, maxScanDays, timeZone).count;
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
  const scan = scanScheduledFires(
    input.cronExpression, input.lastSuccessAt, input.now, MAX_SCAN_DAYS, input.timeZone ?? null,
  );
  const missedFires = scan.count;

  const hours = (ageMs / 3_600_000).toFixed(1);
  if (missedFires === 0) {
    return {
      verdict: 'fresh',
      missedFires,
      ageMs,
      detail: `Last successful run ${hours}h ago; no scheduled run has been missed.`,
    };
  }

  // ── Lateness is measured in HALF PERIODS, not in whole missed runs ──
  //
  // Counting whole runs makes the alert delay scale with the schedule in the
  // wrong direction: three missed fires is 90 minutes on a half-hourly job and
  // three DAYS on a daily one — and three days of silence is almost exactly
  // the outage this detector exists to catch (DEV: 3d 17h, every surface
  // green). The rarer the backup, the longer you would wait to hear that it
  // stopped, which is backwards.
  //
  // So: a run is due, it did not happen, and half of one interval has since
  // passed. That grace is what stops flapping — it is far wider than the
  // minute-either-side jitter the old fire-count band was guarding against,
  // and it scales itself: 15 minutes on a half-hourly schedule, 12 hours on a
  // daily one.
  const graceMs = scan.intervalMs !== null
    ? Math.min(scan.intervalMs / 2, MAX_STALE_GRACE_MS)
    : 0;
  const lateBy = scan.firstFireAt !== null
    ? input.now.getTime() - scan.firstFireAt.getTime()
    : 0;
  const pastGrace = scan.firstFireAt !== null && lateBy >= graceMs;

  // The fire count stays as an absolute backstop for the case the interval
  // cannot be derived (a schedule with no second fire inside the scan window),
  // where there is no period to take half of.
  if (pastGrace || missedFires >= staleAfter) {
    const graceNote = graceMs > 0
      ? ` (more than ${(graceMs / 60_000).toFixed(0)} minutes past the run that was due)`
      : '';
    return {
      verdict: 'stale',
      missedFires,
      ageMs,
      detail: `${missedFires} scheduled run(s) missed since the last success ${hours}h ago${graceNote}.`,
    };
  }

  // Due, but still inside the grace. Hold rather than flap.
  const held = input.previous ?? 'fresh';
  return {
    verdict: held === 'never' ? 'stale' : held,
    missedFires,
    ageMs,
    detail: `${missedFires} scheduled run(s) missed since the last success ${hours}h ago `
      + `(within the ${(graceMs / 60_000).toFixed(0)}-minute grace; holding '${held}').`,
  };
}
