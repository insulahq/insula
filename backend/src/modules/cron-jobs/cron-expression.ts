/**
 * Five-field cron expressions, evaluated against the fields the tenant actually
 * wrote.
 *
 * The previous implementation read the minute field, and only when it was
 * `*​/N`; everything else fell through to "one minute after the last run". So
 * `0 3 * * *` — a nightly job — fired every single minute, 1440 times a day.
 * Harmless-looking while the only job type was an idempotent webcron ping;
 * not harmless at all now that a cron job can run a command inside a tenant's
 * container.
 *
 * Semantics:
 *   - Fields are `minute hour day-of-month month day-of-week`, each accepting
 *     `*`, `N`, `a-b`, lists of those, and a `/step` on any of them.
 *   - Day-of-week is 0-6 with Sunday as 0; 7 is accepted as Sunday too.
 *   - When BOTH day-of-month and day-of-week are restricted, a day matches if
 *     EITHER does — the POSIX rule, and what crontab(5) users expect.
 *   - Expressions are read on a WALL CLOCK, in the job's timezone (its own, or
 *     the platform default, or UTC). `0 3 * * *` means 03:00 where the tenant
 *     is, on both sides of a daylight-saving change — which is the whole point
 *     of storing a zone rather than an offset.
 *   - Daylight saving has two edges, and both are decisions rather than
 *     accidents: a wall time that does not exist (the hour skipped each spring)
 *     is PASSED OVER for that day rather than fired an hour early, and a wall
 *     time that happens twice (the hour repeated each autumn) can run twice —
 *     the two occurrences are genuinely different instants, and skipping the
 *     second would mean silently dropping a run.
 */

/**
 * Returned instead of a date when a schedule cannot be parsed. Far enough in
 * the future that `nextRun > now` is always true, so a malformed expression
 * makes a job dormant rather than making it fire on every single poll — which
 * is what returning epoch used to do.
 */
export const NEVER = new Date(8_640_000_000_000_000);

interface CronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  /** POSIX: both restricted means "either matches", not "both match". */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

/**
 * Expand one field into the set of values it matches, or null if it is not a
 * valid field for the given range.
 */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (part === '') return null;

    const [rangePart, stepPart, ...rest] = part.split('/');
    if (rest.length > 0) return null;

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = Number(stepPart);
      if (step < 1) return null;
    }

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (/^\d+$/.test(rangePart)) {
      start = Number(rangePart);
      // A bare `N/step` means "from N to the end of the range, every step" —
      // `*` is only implied when the value stands alone.
      end = stepPart === undefined ? start : max;
    } else {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2 || !/^\d+$/.test(bounds[0]) || !/^\d+$/.test(bounds[1])) return null;
      start = Number(bounds[0]);
      end = Number(bounds[1]);
    }

    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) values.add(v);
  }

  return values.size > 0 ? values : null;
}

/** Parse a 5-field expression, or null when it is not one. */
export function parseCron(schedule: string): CronFields | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteField, hourField, domField, monthField, dowField] = parts;

  const minute = parseField(minuteField, 0, 59);
  const hour = parseField(hourField, 0, 23);
  const dayOfMonth = parseField(domField, 1, 31);
  const month = parseField(monthField, 1, 12);
  const dowRaw = parseField(dowField, 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dowRaw) return null;

  // 7 and 0 are both Sunday.
  const dayOfWeek = new Set<number>();
  for (const d of dowRaw) dayOfWeek.add(d === 7 ? 0 : d);

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domRestricted: domField !== '*',
    dowRestricted: dowField !== '*',
  };
}

/**
 * A wall-clock instant, as the tenant's timezone shows it. Cron expressions are
 * written against a wall clock — "03:00" means 03:00 where the tenant is, not
 * an offset from UTC — so the whole search runs in these fields and converts to
 * an instant only at the end.
 */
interface WallTime {
  readonly year: number;
  readonly month: number;   // 1-12
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // h23 rather than hour12:false — some ICU versions render midnight as
      // "24" under hour12:false, which would silently shift every match.
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Is this a timezone the runtime actually knows? */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading of an instant in `timeZone`. */
export function wallTimeIn(instant: Date, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

/** Offset of `timeZone` from UTC at a given instant, in milliseconds. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const w = wallTimeIn(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0);
  // Seconds are dropped on both sides, so compare against a truncated instant.
  return asUtc - Math.floor(instant.getTime() / 60_000) * 60_000;
}

/**
 * The instant at which `timeZone`'s wall clock reads `wall`.
 *
 * Two passes: the first guesses using the offset in force at the naive instant,
 * the second corrects it when that guess landed on the other side of a DST
 * transition. A wall time that does not exist (the hour skipped each spring)
 * has no exact answer — the caller checks for that.
 */
export function instantFromWall(wall: WallTime, timeZone: string): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  const DAY = 24 * 60 * 60_000;

  // Two candidates, from the offsets in force on either side of any transition
  // near this wall time. Iterating from the naive instant instead converges on
  // whichever side it started from — which, in the hour repeated each autumn,
  // is the LATER occurrence: a 02:30 job would have run at 02:30 CET rather
  // than the 02:30 CEST an hour earlier that the tenant is waiting for.
  const before = naive - offsetMsAt(new Date(naive - DAY), timeZone);
  const after = naive - offsetMsAt(new Date(naive + DAY), timeZone);

  const sameWall = (ts: number) => {
    const w = wallTimeIn(new Date(ts), timeZone);
    return w.year === wall.year && w.month === wall.month && w.day === wall.day
      && w.hour === wall.hour && w.minute === wall.minute;
  };

  // Earliest first: a repeated wall time fires at its first occurrence.
  for (const ts of [before, after].sort((a, b) => a - b)) {
    if (sameWall(ts)) return new Date(ts);
  }
  // Neither reads back: this wall time does not exist (the hour skipped each
  // spring). Hand back a non-matching instant — the caller checks and skips.
  return new Date(Math.max(before, after));
}

/** Calendar helpers — plain arithmetic on the wall fields, no zone involved. */
function wallToUtcDate(w: WallTime): Date {
  return new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0));
}

function utcDateToWall(d: Date): WallTime {
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

function addMinutes(w: WallTime, n: number): WallTime {
  const d = wallToUtcDate(w);
  d.setUTCMinutes(d.getUTCMinutes() + n);
  return utcDateToWall(d);
}

function startOfNextDay(w: WallTime): WallTime {
  const d = wallToUtcDate({ ...w, hour: 0, minute: 0 });
  d.setUTCDate(d.getUTCDate() + 1);
  return utcDateToWall(d);
}

function startOfNextHour(w: WallTime): WallTime {
  const d = wallToUtcDate({ ...w, minute: 0 });
  d.setUTCHours(d.getUTCHours() + 1);
  return utcDateToWall(d);
}

/** Day-of-week of a wall date. A calendar date has one, whatever the zone. */
function weekdayOf(w: WallTime): number {
  return wallToUtcDate(w).getUTCDay();
}

function dayMatches(fields: CronFields, w: WallTime): boolean {
  const domHit = fields.dayOfMonth.has(w.day);
  const dowHit = fields.dayOfWeek.has(weekdayOf(w));

  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/**
 * The first minute strictly after `base` that the schedule matches, read on
 * `timeZone`'s wall clock.
 *
 * Searching minute by minute across a `0 0 29 2 *` (29 February) would be two
 * million iterations, so days and hours that cannot match are skipped whole.
 */
function nextMatch(fields: CronFields, base: Date, timeZone: string): Date {
  let wall = addMinutes(wallTimeIn(base, timeZone), 1);

  // Four years covers the leap-day case; beyond that the expression matches
  // nothing reachable and the job stays dormant rather than spinning.
  const limitMs = base.getTime() + 4 * 366 * 24 * 60 * 60 * 1000;

  for (let guard = 0; guard < 4 * 366 * 24 * 60; guard++) {
    if (!fields.month.has(wall.month) || !dayMatches(fields, wall)) {
      wall = startOfNextDay(wall);
    } else if (!fields.hour.has(wall.hour)) {
      wall = startOfNextHour(wall);
    } else if (!fields.minute.has(wall.minute)) {
      wall = addMinutes(wall, 1);
    } else {
      const instant = instantFromWall(wall, timeZone);
      if (instant.getTime() > limitMs) return NEVER;

      // The hour skipped each spring has no instant: converting back lands on
      // a different wall time. Such a match is passed over rather than fired an
      // hour early — 02:30 on a night that has no 02:30 simply does not run.
      const check = wallTimeIn(instant, timeZone);
      if (check.hour === wall.hour && check.minute === wall.minute && check.day === wall.day) {
        return instant;
      }
      wall = addMinutes(wall, 1);
      continue;
    }

    if (wallToUtcDate(wall).getTime() - wallToUtcDate(wallTimeIn(base, timeZone)).getTime()
        > 4 * 366 * 24 * 60 * 60 * 1000) {
      return NEVER;
    }
  }

  return NEVER;
}

/**
 * The next time this job should run, measured from `since` — the end of its
 * last run, or the moment it was created if it has never run.
 *
 * `since` is required, and that is the whole point. It used to accept null and
 * fall back to `now`, which looks reasonable and is fatal: the scheduler
 * re-evaluates every 30 seconds, so "the next match after now" moved forward
 * on every poll and a job that had never run could never become due. It was
 * caught on a real cluster by a `* * * * *` Moodle cron that sat at
 * "Never" — the unit tests passed because each of them called this once, with
 * one fixed `now`, which is exactly the case that works.
 *
 * Pass a fixed point (`lastRunAt ?? createdAt`) and the answer stops moving.
 */
export function getNextRunTime(
  schedule: string,
  since: Date,
  now: Date = new Date(),
  timeZone = 'UTC',
): Date {
  void now;
  const fields = parseCron(schedule);
  if (!fields) return NEVER;

  // A zone the runtime does not know must not make the job fire at the wrong
  // time, and must not make it silently dormant either: fall back to UTC,
  // which is what the row meant before timezones existed.
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  return nextMatch(fields, since, zone);
}
