/**
 * 5-field cron MINUTE matcher (R17.1 platform-fired snapshots).
 *
 * Answers exactly one question: "does this cron expression fire at this
 * wall-clock minute?" — which is all a per-minute firing engine needs.
 * No next-fire computation.
 *
 * TIME ZONE. `cronMatchesMinute` reads the Date's UTC fields. That is the
 * primitive, not the policy: schedules an operator types are wall-clock
 * times in the platform's configured zone (`system_settings.timezone`),
 * which is also what the platform writes into every CronJob's
 * `spec.timeZone`. Firing engines MUST therefore go through
 * `cronMatchesMinuteInZone`, or a cluster in a non-UTC zone fires its
 * platform-side schedules at a different time than its CronJobs — the
 * exact split this module's earlier "the platform runs UTC everywhere"
 * assumption produced.
 *
 * Only the MATCH is shifted. The instant a caller then records
 * (`last_fired_at`, `minuteStamp` in a Job name) must stay a true UTC
 * instant, or replica claims and deterministic Job names break.
 *
 * Grammar intentionally mirrors @insula/api-contracts
 * validateCronExpression (the write-path gate): `*`, integers, `A-B`
 * ranges, `/N` steps on `*` or ranges, comma lists. Alpha aliases
 * (JAN/MON) are NOT supported — the validator rejects them on write, so
 * they can never reach us. Callers MUST only pass validator-accepted
 * expressions; on any parse surprise this returns false (never fires)
 * rather than guessing.
 *
 * DOM/DOW semantics follow POSIX/Kubernetes cron: when BOTH fields are
 * restricted (neither is `*`), the date matches if EITHER matches.
 */

interface FieldSpec {
  readonly min: number;
  readonly max: number;
}

const FIELDS: ReadonlyArray<FieldSpec> = [
  { min: 0, max: 59 },  // minute
  { min: 0, max: 23 },  // hour
  { min: 1, max: 31 },  // day-of-month
  { min: 1, max: 12 },  // month
  { min: 0, max: 7 },   // day-of-week (0 and 7 = Sunday)
];

/** Expand one cron field token into the set of matching values. Returns null on any parse problem. */
export function expandCronField(token: string, spec: FieldSpec): Set<number> | null {
  if (token === '') return null;
  if (token.includes(',')) {
    const out = new Set<number>();
    for (const part of token.split(',')) {
      const s = expandCronField(part, spec);
      if (!s) return null;
      for (const v of s) out.add(v);
    }
    return out;
  }
  let base = token;
  let step = 1;
  const slash = token.indexOf('/');
  if (slash >= 0) {
    base = token.slice(0, slash);
    const stepStr = token.slice(slash + 1);
    if (!/^\d+$/.test(stepStr)) return null;
    step = Number(stepStr);
    if (step < 1) return null;
  }
  let lo: number;
  let hi: number;
  if (base === '*') {
    lo = spec.min; hi = spec.max;
  } else if (/^\d+$/.test(base)) {
    lo = hi = Number(base);
    if (lo < spec.min || lo > spec.max) return null;
    // `N/step` means "starting at N, every step to max" in many crons;
    // our validator allows the syntax, so honor it.
    if (slash >= 0) hi = spec.max;
  } else {
    const m = base.match(/^(\d+)-(\d+)$/);
    if (!m) return null;
    lo = Number(m[1]); hi = Number(m[2]);
    if (lo < spec.min || hi > spec.max || lo > hi) return null;
  }
  const out = new Set<number>();
  for (let v = lo; v <= hi; v += step) out.add(v);
  return out;
}

/**
 * Does `expr` fire at the minute containing `at`? Seconds/millis are
 * ignored — call once per distinct wall-clock minute.
 */
export function cronMatchesMinute(expr: string, at: Date): boolean {
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length !== 5) return false;
  const sets: Array<Set<number>> = [];
  for (let i = 0; i < 5; i++) {
    const s = expandCronField(tokens[i], FIELDS[i]);
    if (!s) return false;
    sets.push(s);
  }
  const [minuteSet, hourSet, domSet, monthSet, dowSet] = sets;
  // Normalise Sunday: 7 → 0.
  if (dowSet.has(7)) dowSet.add(0);

  if (!minuteSet.has(at.getUTCMinutes())) return false;
  if (!hourSet.has(at.getUTCHours())) return false;
  if (!monthSet.has(at.getUTCMonth() + 1)) return false;

  const domRestricted = tokens[2] !== '*';
  const dowRestricted = tokens[4] !== '*';
  const domMatch = domSet.has(at.getUTCDate());
  const dowMatch = dowSet.has(at.getUTCDay());
  if (domRestricted && dowRestricted) return domMatch || dowMatch; // POSIX OR rule
  if (domRestricted) return domMatch;
  if (dowRestricted) return dowMatch;
  return true;
}

/**
 * Offset, in ms, between UTC and `timeZone` at a given instant.
 *
 * DST-correct because Intl resolves the zone AT that instant rather than
 * applying a fixed offset. Unknown zone → 0, i.e. UTC: one bad zone string
 * must not stop every schedule on the cluster from firing. Built-in Intl,
 * no luxon/date-fns-tz dependency.
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
 * Build a shifter that maps a real UTC instant to a Date whose **UTC fields
 * read as `timeZone`'s wall clock** — which is what the matcher above needs
 * to see. The returned Date is a matching fixture, never an instant to store.
 *
 * Minute-stepping is cheap; Intl is not. The offset can only change at a DST
 * boundary, so resolving it once per UTC hour is exact and turns a 45-day
 * scan from ~65,000 Intl lookups into ~1,000.
 */
export function makeZoneShifter(timeZone: string | null): (utcMs: number) => Date {
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
    return new Date(utcMs + offset);
  };
}

/**
 * Does `expr` fire at the minute containing `at`, read in `timeZone`?
 *
 * This is what every firing engine should call. `at` stays the caller's real
 * instant — only the comparison is done against the zone's wall clock.
 *
 * DST note: a daily schedule inside a spring-forward gap does not fire that
 * day (the wall-clock minute does not exist), and one inside a fall-back
 * repeat can match twice. Callers already de-duplicate on `last_fired_at` or
 * a deterministic Job name, which covers the second case.
 */
export function cronMatchesMinuteInZone(expr: string, at: Date, timeZone: string | null): boolean {
  if (!timeZone || timeZone === 'UTC' || timeZone === 'Etc/UTC') {
    return cronMatchesMinute(expr, at);
  }
  return cronMatchesMinute(expr, new Date(at.getTime() + zoneOffsetMs(at, timeZone)));
}

/** Deterministic per-minute job-name suffix (UTC): YYYYMMDDHHmm. */
export function minuteStamp(at: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}${p(at.getUTCHours())}${p(at.getUTCMinutes())}`;
}
