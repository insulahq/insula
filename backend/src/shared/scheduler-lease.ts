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

const DEFAULT_TIMING = {
  livenessMs: LEASE_LIVENESS_MS,
  keepAliveEveryMs: KEEP_ALIVE_EVERY_MS,
  startupDelayMs: LEASED_STARTUP_DELAY_MS,
  startupLastTryMs: STARTUP_LAST_TRY_MS,
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
   * Stop renewing once the run has lasted this long, and say so. The lease
   * then runs out after its ttl and another replica may start the work — for
   * a lock that must not be held for ever by a run that hangs (a call to the
   * cluster with no timeout). Default: renew for as long as `fn` is pending.
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
 * database blip.
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
  const startedAt = performance.now();
  let gaveUp = false;
  const timer = setInterval(() => {
    if (opts.maxHoldMs !== undefined && performance.now() - startedAt >= opts.maxHoldMs) {
      if (!gaveUp) {
        gaveUp = true;
        opts.log?.warn({ job, holder, maxHoldMs: opts.maxHoldMs },
          'scheduler lease: the run has outlasted its longest hold and is no longer renewed — it may be hung; another replica can start the work once the lease runs out');
      }
      return;
    }
    renewing = claimSchedulerLease(db, job, ttlMs, holder).then((kept) => {
      if (!kept) opts.log?.warn({ job, holder }, 'scheduler lease: lost to another replica while running');
    }, (err: unknown) => {
      opts.log?.warn({ job, err: err instanceof Error ? err.message : String(err) }, 'scheduler lease: renewal failed');
    });
  }, Math.max(1000, renewEveryMs));
  timer.unref?.();
  if (sticky) ranHere.add(firstKey);
  try {
    return { ran: true, value: await fn() };
  } finally {
    clearInterval(timer);
    // The job counts as running here until its lease has reached its resting
    // state: a tick let in earlier would have its fresh claim cut back, or its
    // run lock deleted, by the writes below.
    try {
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
    } finally {
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
