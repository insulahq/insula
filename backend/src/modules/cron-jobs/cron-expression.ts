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
 *   - Everything is evaluated in **UTC**, because that is the only clock the
 *     platform has for these rows: cron_jobs carries no timezone column. A
 *     tenant in CEST asking for `0 3 * * *` gets 05:00 local in summer. Worth
 *     saying out loud — a backup job "running at the wrong time" was a real
 *     support ticket the last time a scheduler assumed UTC silently.
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

function dayMatches(fields: CronFields, date: Date): boolean {
  const domHit = fields.dayOfMonth.has(date.getUTCDate());
  const dowHit = fields.dayOfWeek.has(date.getUTCDay());

  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/**
 * The first minute strictly after `base` that the schedule matches.
 *
 * Searching minute by minute across a `0 0 29 2 *` (29 February) would be two
 * million iterations, so days that cannot match are skipped whole.
 */
function nextMatch(fields: CronFields, base: Date): Date {
  const cursor = new Date(base.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  // Four years covers the leap-day case; beyond that the expression matches
  // nothing reachable and the job stays dormant rather than spinning.
  const limit = new Date(cursor.getTime() + 4 * 366 * 24 * 60 * 60 * 1000);

  while (cursor < limit) {
    if (!fields.month.has(cursor.getUTCMonth() + 1) || !dayMatches(fields, cursor)) {
      // Jump to 00:00 of the next day.
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hour.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (fields.minute.has(cursor.getUTCMinutes())) return cursor;
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
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
): Date {
  void now;
  const fields = parseCron(schedule);
  if (!fields) return NEVER;

  return nextMatch(fields, since);
}
