/**
 * Run a scheduled job on ONE platform-api replica at a time.
 *
 * Every in-process scheduler starts on every replica, and HA runs three. A job
 * that does not claim its work runs three times: two restic prunes on one
 * repository (the second fails on the exclusive lock and pages an admin), a
 * bandwidth window billed twice, an expired tenant suspended twice, an app
 * upgraded by two replicas at once.
 *
 * The lease is sticky, one row per job in `platform_settings`
 * (`scheduler-lease:<job>` → `{"holder","until"}`):
 *   - a replica runs a tick only when it already holds the lease or the lease
 *     has expired — so the holder keeps running every tick and the others skip;
 *   - every tick and, while a long run is in flight, a renewal timer push
 *     `until` to `now() + ttl`;
 *   - when the holder dies, its lease runs out after `ttl` and the next replica
 *     to tick takes the job over.
 * Every `until` is the database's `now()` plus a duration, never a pod clock,
 * so skew between nodes cannot hand the job to two replicas. (A process only
 * measures durations of its own, on its monotonic clock.) A `ttl` of about 1.5 × the job's
 * interval keeps a live holder from losing the lease between two of its own
 * ticks.
 *
 * Two things keep a long interval from turning into a long outage of the job:
 *   - Liveness. While a job RUNS its lease covers the job's whole ttl, as it
 *     always did: the work may outlive the process, and nobody must start it
 *     again beside itself. Once the run ends the lease is cut back to
 *     LEASE_LIVENESS_MS, and a keep-alive in the holding process extends it
 *     until one ttl after that run with no further run. A holder that dies between
 *     runs — where a process spends nearly all its time — therefore frees a
 *     daily job's lease within minutes instead of a day and a half.
 *   - The start-up run. During a rollout the new process starts while the one
 *     it replaces still holds the lease, so its first tick is refused and the
 *     job would wait a whole interval. A job with a long interval that is
 *     refused on its first tick in a process is tried again twice: after
 *     LEASED_STARTUP_DELAY_MS, when a process replaced by the rollout has given
 *     the lease up, and once more when a holder that died has lost it.
 *
 * A job never runs twice at once in one process either: a tick that finds the
 * job still running here is refused like any other.
 *
 * A run that never returns — a call to the cluster with no timeout — would
 * therefore stop its job for good: every later tick is refused here, the lease
 * is renewed for ever, and a timer that re-arms itself after its tick never
 * does. So every run has a longest hold. Past it the helper gives the run up:
 * it says so, frees the job (here and, for a run lock, everywhere), and throws
 * to its caller, whose next tick starts the job afresh. The run given up may
 * still be pending; whatever it returns later goes nowhere. The hold is far
 * above any honest run, because a run given up while it is merely slow is
 * joined by a second one.
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { sql, type SQL } from 'drizzle-orm';

/** Any drizzle database: the lease only runs raw statements. */
export interface LeaseDb {
  execute(query: SQL): Promise<unknown>;
}

/** This process. A restarted pod is a new holder: its old lease simply expires. */
export const REPLICA_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;

/**
 * How long after a refused first tick a job with a long interval is tried
 * again (see the header). By then a process replaced by a rollout is gone; on
 * a cluster with other live replicas the lease is still theirs and the later
 * tries are refused too, as they should be.
 */
export const LEASED_STARTUP_DELAY_MS = 3 * 60_000;

/** Only a job whose own next tick is further away than this gets the later tries. */
const STARTUP_RETRY_MIN_TTL_MS = 3 * LEASED_STARTUP_DELAY_MS;

/**
 * The furthest ahead a sticky lease is ever written. A holder that stops
 * renewing — killed, or starved of its database — loses the job after at most
 * this long, whatever the job's interval.
 */
export const LEASE_LIVENESS_MS = 10 * 60_000;

/** How often the holding process extends its long leases: five tries per liveness window. */
const KEEP_ALIVE_EVERY_MS = LEASE_LIVENESS_MS / 5;

/**
 * When the last try of a refused start-up run is made, counted from the
 * refusal: just past the liveness window, by when a holder that died between
 * runs has lost the lease.
 */
const STARTUP_LAST_TRY_MS = LEASE_LIVENESS_MS + 60_000;

/** Every lease's platform_settings key is this prefix + the job name. */
export const SCHEDULER_LEASE_KEY_PREFIX = 'scheduler-lease:';
const KEY_PREFIX = SCHEDULER_LEASE_KEY_PREFIX;

/**
 * The shortest default longest hold. A job's own default is four of its ttls
 * (six intervals) when that is longer — a daily job is given six days.
 */
export const LEASE_MAX_HOLD_FLOOR_MS = 12 * 60 * 60_000;

/** The furthest ahead a timer can be set; a longer delay fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The longest a run of a job with this ttl is waited for, unless its caller says otherwise. */
export const defaultMaxHoldMs = (ttlMs: number): number => Math.max(4 * ttlMs, LEASE_MAX_HOLD_FLOOR_MS);

/** Thrown to the caller of a run that was given up (see the header). */
export class LeasedRunAbandonedError extends Error {
  readonly job: string;
  readonly heldMs: number;
  constructor(job: string, heldMs: number) {
    super(`the run of "${job}" did not return within ${formatHold(heldMs)} and was given up; it may still be pending in this process`);
    this.name = 'LeasedRunAbandonedError';
    this.job = job;
    this.heldMs = heldMs;
  }
}

function formatHold(ms: number): string {
  if (ms >= 2 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} h`;
  if (ms >= 2 * 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)} s`;
}

export interface AbandonedRun {
  readonly job: string;
  readonly holder: string;
  readonly heldMs: number;
}

/**
 * Told about every run given up, besides the log line — the server wires an
 * operator notification here. It must not throw; a failure is logged only.
 */
let abandonedRunReporter: ((run: AbandonedRun) => void | Promise<void>) | null = null;
export function setAbandonedRunReporter(reporter: ((run: AbandonedRun) => void | Promise<void>) | null): void {
  abandonedRunReporter = reporter;
}

function reportAbandonedRun(run: AbandonedRun, log: LeaseLogger | undefined): void {
  const msg = `scheduler lease: the run did not return within ${formatHold(run.heldMs)} and was given up — the job is free to start again; the run given up may still be pending`;
  if (log) log.warn(run, msg);
  else console.error(`[scheduler-lease] ${msg}`, run);
  if (!abandonedRunReporter) return;
  void Promise.resolve().then(() => abandonedRunReporter?.(run)).catch((err: unknown) => {
    console.error('[scheduler-lease] could not report the run given up:', err instanceof Error ? err.message : String(err));
  });
}

/**
 * Jobs whose `fn` is running in this process right now, by lease name. A
 * graceful shutdown must not hand these to another replica: the work is still
 * in flight (a restic prune it spawned may even outlive this process), so its
 * lease is left to expire on its own, exactly as after a crash.
 */
const inFlight = new Set<string>();

export interface LeaseLogger {
  readonly warn: (obj: unknown, msg?: string) => void;
  readonly info?: (obj: unknown, msg?: string) => void;
}

/** A sticky lease this process holds between runs, whose ttl is longer than the liveness window. */
interface HeldLease {
  readonly db: LeaseDb;
  readonly holder: string;
  /** Monotonic process clock (`performance.now()`): until when the job's last run entitles this process to the lease. */
  readonly horizon: number;
  readonly log?: LeaseLogger;
  /** The keep-alive claim on its way to the database, if any. */
  pending?: Promise<void>;
}

/**
 * How long the lease writes that follow a run are waited for before the job
 * is freed in this process without them. Far above a slow statement; reached
 * only by a database that has stopped answering.
 */
const LEASE_SETTLE_MS = 60_000;

const DEFAULT_TIMING = {
  livenessMs: LEASE_LIVENESS_MS,
  keepAliveEveryMs: KEEP_ALIVE_EVERY_MS,
  startupDelayMs: LEASED_STARTUP_DELAY_MS,
  startupLastTryMs: STARTUP_LAST_TRY_MS,
  afterRunWaitMs: LEASE_SETTLE_MS,
};
let timing = { ...DEFAULT_TIMING };
const held = new Map<string, HeldLease>();
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
/** Jobs that have had their first tick in this process (job + holder). */
const firstTickSeen = new Set<string>();
/** Jobs this process has run at least once (job + holder): a later start-up try has nothing left to make up for. */
const ranHere = new Set<string>();
/** Set when this process gives its leases up to stop: a start-up try still pending must not take one back. */
let stopping = false;

/**
 * Extend every long lease this process holds between runs, until its job's
 * ttl has passed without a tick (the process is alive but no longer runs the
 * job). A job that is running renews its own lease, for its whole ttl.
 */
function keepLeasesAlive(): void {
  for (const [job, lease] of held) {
    if (inFlight.has(job) || lease.pending) continue;
    const left = lease.horizon - performance.now();
    if (left <= 0) {
      held.delete(job);
      continue;
    }
    // Extend-only: a run that started a moment ago has just written the lease
    // for its whole ttl, and this must not cut it back.
    const pending: Promise<void> = claimSchedulerLease(lease.db, job, Math.min(timing.livenessMs, left), lease.holder, { extendOnly: true }).then((kept) => {
      // Only if this is still the entry the claim was made for: a newer run may
      // have taken the lease again since.
      if (!kept && held.get(job) === lease) {
        held.delete(job);
        lease.log?.warn({ job, holder: lease.holder }, 'scheduler lease: lost to another replica between runs');
      }
    }, (err: unknown) => {
      lease.log?.warn({ job, err: err instanceof Error ? err.message : String(err) }, 'scheduler lease: keep-alive failed');
    }).finally(() => {
      if (lease.pending === pending) lease.pending = undefined;
    });
    lease.pending = pending;
  }
  if (held.size === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function holdLongLease(job: string, lease: HeldLease): void {
  // A claim still on its way for the entry being replaced stays awaited.
  const before = held.get(job)?.pending;
  if (before) lease.pending = lease.pending ? Promise.all([before, lease.pending]).then(() => undefined) : before;
  held.set(job, lease);
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(keepLeasesAlive, timing.keepAliveEveryMs);
    keepAliveTimer.unref?.();
  }
}

/**
 * Stop keeping `leases` alive and wait for a keep-alive claim already on its
 * way: landing after the row is deleted, it would write the lease back.
 */
async function letGo(leases: ReadonlyArray<readonly [string, HeldLease]>): Promise<void> {
  for (const [job, lease] of leases) {
    if (held.get(job) === lease) held.delete(job);
  }
  await Promise.all(leases.map(([, lease]) => lease.pending));
}

/** Tests only: shorten the windows and delays, and forget what this process holds — as if it had just started. */
export function __setLeaseTimingForTests(t: Partial<typeof DEFAULT_TIMING> | null): void {
  timing = t ? { ...timing, ...t } : { ...DEFAULT_TIMING };
  held.clear();
  firstTickSeen.clear();
  ranHere.clear();
  stopping = false;
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

/**
 * Take or keep `job`'s lease for `ttlMs`. True when this holder now owns it.
 * One conditional upsert: the row is written only when it is missing, already
 * this holder's, expired, or unreadable — a concurrent claimer sees the other
 * holder's fresh `until` and matches nothing. With `extendOnly`, a lease this
 * holder already has for longer is kept as it is (and still counts as owned).
 */
export async function claimSchedulerLease(
  db: LeaseDb,
  job: string,
  ttlMs: number,
  holder: string = REPLICA_ID,
  opts: { readonly extendOnly?: boolean } = {},
): Promise<boolean> {
  const key = `${KEY_PREFIX}${job}`;
  const ttl = Math.max(1000, Math.round(ttlMs));
  const extendOnly = opts.extendOnly === true;
  const res = await db.execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value, updated_at)
    VALUES (
      ${key},
      json_build_object('holder', ${holder}::text, 'until', now() + (${ttl}::bigint * interval '1 millisecond'))::text,
      now()
    )
    ON CONFLICT (setting_key) DO UPDATE
      SET setting_value = CASE
            WHEN ${extendOnly}::boolean
             AND pg_input_is_valid(platform_settings.setting_value, 'jsonb')
             AND (platform_settings.setting_value::jsonb ->> 'holder') = ${holder}::text
             AND pg_input_is_valid(platform_settings.setting_value::jsonb ->> 'until', 'timestamptz')
             AND (platform_settings.setting_value::jsonb ->> 'until')::timestamptz
                 > now() + (${ttl}::bigint * interval '1 millisecond')
            THEN platform_settings.setting_value
            ELSE EXCLUDED.setting_value
          END,
          updated_at = now()
      WHERE CASE
        WHEN pg_input_is_valid(platform_settings.setting_value, 'jsonb') THEN
          (platform_settings.setting_value::jsonb ->> 'holder') = ${holder}::text
          OR coalesce(CASE
            WHEN pg_input_is_valid(platform_settings.setting_value::jsonb ->> 'until', 'timestamptz')
              THEN (platform_settings.setting_value::jsonb ->> 'until')::timestamptz < now()
          END, true)
        ELSE true
      END
    RETURNING setting_key
  `) as unknown as { rows?: unknown[] };
  return (res.rows ?? []).length > 0;
}

/**
 * Give `job`'s lease up now (only if this holder has it), so the next claimer
 * does not wait for it to expire. For a lease used as a run lock rather than a
 * schedule owner.
 */
export async function releaseSchedulerLease(
  db: LeaseDb,
  job: string,
  holder: string = REPLICA_ID,
): Promise<void> {
  const lease = held.get(job);
  if (lease?.holder === holder) await letGo([[job, lease]]);
  await db.execute(sql`
    DELETE FROM platform_settings
     WHERE setting_key = ${`${KEY_PREFIX}${job}`}
       AND pg_input_is_valid(setting_value, 'jsonb')
       AND (setting_value::jsonb ->> 'holder') = ${holder}::text
  `);
}

/**
 * Give up every lease this process holds — on graceful shutdown. A rollout
 * replaces every pod, and the new processes are new holders: without this,
 * each job would wait for the old holder's lease to lapse after every deploy.
 * A crashed process cannot release; its leases expire on their own — and so do
 * the leases of jobs still running here (`runningSchedulerJobs`), so a sweep
 * cut off by the rollout is not started a second time alongside itself.
 */
export async function releaseAllSchedulerLeases(
  db: LeaseDb,
  holder: string = REPLICA_ID,
  keep: readonly string[] = runningSchedulerJobs(),
): Promise<number> {
  if (holder === REPLICA_ID) stopping = true;
  await letGo([...held].filter(([job, lease]) => lease.holder === holder && !keep.includes(job)));
  const kept = keep.length > 0
    ? sql`AND setting_key NOT IN (${sql.join(keep.map((job) => sql`${`${KEY_PREFIX}${job}`}`), sql`, `)})`
    : sql``;
  const res = await db.execute(sql`
    DELETE FROM platform_settings
     WHERE setting_key LIKE ${`${KEY_PREFIX}%`}
       AND pg_input_is_valid(setting_value, 'jsonb')
       AND (setting_value::jsonb ->> 'holder') = ${holder}::text
       ${kept}
    RETURNING setting_key
  `) as unknown as { rows?: unknown[] };
  return (res.rows ?? []).length;
}

/** Lease names whose job is running in this process right now. */
export function runningSchedulerJobs(): string[] {
  return [...inFlight];
}

export interface LeaseOptions {
  readonly holder?: string;
  /**
   * Release the lease when `fn` settles — a run lock ("one sweep at a time")
   * instead of a sticky schedule owner ("this replica runs the job").
   */
  readonly release?: boolean;
  /** How often a long run renews its lease. Default: a third of the ttl, at most every 5 min. */
  readonly renewEveryMs?: number;
  /**
   * The longest the run is waited for. Past it the run is given up (see the
   * header): the job is freed and LeasedRunAbandonedError is thrown. Default:
   * `defaultMaxHoldMs(ttlMs)`. `Infinity` waits for ever — only for work that
   * bounds itself and must never be started beside itself.
   */
  readonly maxHoldMs?: number;
  /**
   * False for a job that must not be run later when its first tick is refused
   * — a start-up one-shot whose caller wants its result, or which another
   * replica is already doing.
   */
  readonly startupRetry?: boolean;
  readonly log?: LeaseLogger;
}

export type LeaseOutcome<T> = { readonly ran: true; readonly value: T } | { readonly ran: false };

/**
 * Run `fn` if this replica holds (or can take) `job`'s lease and is not
 * already running the job; otherwise skip. The lease is renewed while `fn`
 * runs, so a run longer than `ttlMs` is not taken over mid-flight. A failure
 * to renew is logged, never thrown — the run in flight is not abandoned over a
 * database blip. A run that outlasts its longest hold is given up, and that is
 * thrown (LeasedRunAbandonedError).
 *
 * A sticky job with a long ttl that is refused on its first tick in this
 * process may be run later by the helper itself (see the header). `fn` then
 * runs outside the caller's tick: its value goes nowhere, and only the fact
 * that it ran is logged. Pass `startupRetry: false` where that is wrong.
 */
export async function withSchedulerLease<T>(
  db: LeaseDb,
  job: string,
  ttlMs: number,
  fn: () => Promise<T>,
  opts: LeaseOptions = {},
): Promise<LeaseOutcome<T>> {
  const holder = opts.holder ?? REPLICA_ID;
  const sticky = !opts.release;
  // The same holder's claim always succeeds, so the database cannot refuse a
  // second run in this process — this does.
  if (inFlight.has(job)) return { ran: false };
  inFlight.add(job);

  let claimed = false;
  try {
    claimed = await claimSchedulerLease(db, job, ttlMs, holder);
  } finally {
    if (!claimed) inFlight.delete(job);
  }
  // Counted once the claim has answered: a database that was down at the first
  // tick must not use the later tries up.
  const firstKey = `${job}\u0000${holder}`;
  const firstTick = sticky && !firstTickSeen.has(firstKey);
  if (sticky) firstTickSeen.add(firstKey);
  if (!claimed) {
    if (firstTick && opts.startupRetry !== false && ttlMs > STARTUP_RETRY_MIN_TTL_MS) {
      retryStartupRun(db, job, ttlMs, fn, opts, 0);
    }
    return { ran: false };
  }

  const renewEveryMs = opts.renewEveryMs ?? Math.min(ttlMs / 3, 5 * 60_000);
  let renewing: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewing = claimSchedulerLease(db, job, ttlMs, holder).then((kept) => {
      if (!kept) opts.log?.warn({ job, holder }, 'scheduler lease: lost to another replica while running');
    }, (err: unknown) => {
      opts.log?.warn({ job, err: err instanceof Error ? err.message : String(err) }, 'scheduler lease: renewal failed');
    });
  }, Math.max(1000, renewEveryMs));
  timer.unref?.();
  if (sticky) ranHere.add(firstKey);
  const maxHoldMs = opts.maxHoldMs ?? defaultMaxHoldMs(ttlMs);
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!Number.isFinite(maxHoldMs)) return { ran: true, value: await fn() };
    const GIVEN_UP = Symbol('given up');
    const startedAt = performance.now();
    const run = (async () => fn())();
    const first = await Promise.race([
      run,
      new Promise<typeof GIVEN_UP>((resolve) => {
        giveUp = setTimeout(() => resolve(GIVEN_UP), Math.min(MAX_TIMER_MS, Math.max(0, maxHoldMs)));
        giveUp.unref?.();
      }),
    ]);
    if (first !== GIVEN_UP) return { ran: true, value: first as T };
    // The run goes on by itself, if it goes on at all. Whatever it ends with
    // has nobody left to go to — say so, and keep a late failure from counting
    // as an unhandled one.
    const lateEnd = (how: 'returned' | 'failed', err?: unknown): void => {
      const late = {
        job, holder, afterMs: Math.round(performance.now() - startedAt),
        ...(how === 'failed' ? { err: err instanceof Error ? err.message : String(err) } : {}),
      };
      const msg = `scheduler lease: a run given up earlier has ${how} after all; its result is dropped`;
      if (opts.log) opts.log.warn(late, msg);
      else console.warn(`[scheduler-lease] ${msg}`, late);
    };
    run.then(() => lateEnd('returned'), (err: unknown) => lateEnd('failed', err));
    reportAbandonedRun({ job, holder, heldMs: maxHoldMs }, opts.log);
    throw new LeasedRunAbandonedError(job, maxHoldMs);
  } finally {
    clearInterval(timer);
    if (giveUp) clearTimeout(giveUp);
    // The job counts as running here until its lease has reached its resting
    // state: a tick let in earlier would have its fresh claim cut back, or its
    // run lock deleted, by the writes below. But not for ever: a database that
    // stops answering just now must not leave the job "running" in this
    // process until it restarts — the state this helper exists to end.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const settled = (async (): Promise<void> => {
      // A renewal on its way would land after them and undo them.
      await renewing;
      if (opts.release || (sticky && stopping)) {
        // A run lock ends with its run. So does a sticky lease whose run ended
        // after this process began to stop: the work is done, hand it over.
        await releaseSchedulerLease(db, job, holder).catch((err: unknown) => {
          opts.log?.warn({ job, err: err instanceof Error ? err.message : String(err) }, 'scheduler lease: release failed (it expires on its own)');
        });
      } else if (ttlMs > timing.livenessMs) {
        // The run is over: from here a dead process must not keep the job for
        // its whole ttl. Cut the lease back and let the keep-alive carry it.
        const lease: HeldLease = { db, holder, horizon: performance.now() + ttlMs, log: opts.log };
        const cut: Promise<void> = claimSchedulerLease(db, job, timing.livenessMs, holder).then(() => undefined, (err: unknown) => {
          opts.log?.warn({ job, err: err instanceof Error ? err.message : String(err) }, 'scheduler lease: could not shorten the lease after the run (the keep-alive will)');
        }).finally(() => {
          if (lease.pending === cut) lease.pending = undefined;
        });
        lease.pending = cut;
        holdLongLease(job, lease);
        await cut;
      }
    })();
    try {
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          settleTimer = setTimeout(() => {
            const detail = { job, holder, afterMs: timing.afterRunWaitMs };
            const msg = 'scheduler lease: the lease writes after the run did not return; the job is freed here without them';
            if (opts.log) opts.log.warn(detail, msg);
            else console.warn(`[scheduler-lease] ${msg}`, detail);
            resolve();
          }, timing.afterRunWaitMs);
          settleTimer.unref?.();
        }),
      ]);
    } finally {
      if (settleTimer) clearTimeout(settleTimer);
      // Whatever the writes come to later has nobody waiting for it.
      settled.catch(() => undefined);
      inFlight.delete(job);
    }
  }
}

/**
 * The later tries of a start-up run that was refused (see the header): after
 * the start-up delay, then once more just past the liveness window. Each goes
 * through the lease like any tick, so it runs only if the lease is free by
 * then — and not at all once this process is stopping, or once the job has
 * run here by its own tick. The caller's tick has long returned, so the run's
 * outcome is reported here.
 */
function retryStartupRun<T>(db: LeaseDb, job: string, ttlMs: number, fn: () => Promise<T>, opts: LeaseOptions, attempt: number): void {
  const delays = [timing.startupDelayMs, timing.startupLastTryMs - timing.startupDelayMs];
  const delay = delays[attempt];
  if (delay === undefined) return;
  const holder = opts.holder ?? REPLICA_ID;
  const timer = setTimeout(() => {
    if (stopping || ranHere.has(`${job}\u0000${holder}`)) return;
    let started = false;
    const run = async (): Promise<void> => {
      if (stopping) return;       // the process began to stop while the claim was on its way
      started = true;
      await fn();
    };
    withSchedulerLease(db, job, ttlMs, run, { ...opts, startupRetry: false }).then((outcome) => {
      if (outcome.ran && started) opts.log?.info?.({ job }, 'scheduler lease: start-up run made on a later try');
      else if (!outcome.ran) retryStartupRun(db, job, ttlMs, fn, opts, attempt + 1);
    }, (err: unknown) => {
      const detail = { job, err: err instanceof Error ? err.message : String(err) };
      if (!started) {
        // The claim failed, not the job: the next try is still owed.
        retryStartupRun(db, job, ttlMs, fn, opts, attempt + 1);
        return;
      }
      if (opts.log) opts.log.warn(detail, 'scheduler lease: start-up run failed');
      else console.warn('[scheduler-lease] start-up run failed', detail);
    });
  }, Math.max(0, delay));
  timer.unref?.();
}
