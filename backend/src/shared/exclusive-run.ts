/**
 * One run of a leased job at a time, whoever starts it.
 *
 * A job's sticky lease (scheduler-lease.ts) decides which replica's TIMER runs
 * the job. It says nothing about a run started some other way — by a route
 * that has just changed what the job reconciles, or by an operator's "run now"
 * button. Such a run lands on whichever replica serves the request, while the
 * timer's run may be under way on another, or in the same process. Two runs at
 * once is exactly what the lease was added to stop: a daemon set rolled twice,
 * a positional patch computed from a snapshot the other run has just changed,
 * an alert sent by both.
 *
 * So the work itself takes a second lease, a run lock (`<job>-run`), given up
 * when the run ends:
 *   - the timer takes it inside its sticky lease and skips its tick when the
 *     lock is busy — a run is under way, which is what the tick wanted;
 *   - every other caller waits for it, so that its own run starts after the
 *     one under way has finished. A run started because something changed
 *     must begin after that change was written; joining a run that may have
 *     read the old state would leave the change waiting for the next tick.
 *
 * A holder that dies loses the lock after RUN_LOCK_TTL_MS; a live run renews it,
 * for RUN_LOCK_MAX_HOLD_MS at most. A run that hangs — a call to the cluster
 * that never returns — is given up after that long (scheduler-lease.ts): the
 * lock is released, the job is free again on every replica, this one included,
 * and the caller gets LeasedRunAbandonedError.
 */
import { sql } from 'drizzle-orm';
import type { OperatorError } from '@insula/api-contracts';
import { ApiError } from './errors.js';
import {
  SCHEDULER_LEASE_KEY_PREFIX,
  withSchedulerLease,
  type LeaseDb,
  type LeaseLogger,
  type LeaseOutcome,
} from './scheduler-lease.js';

/** How far ahead a run lock is written. A run under way renews it every third of this. */
export const RUN_LOCK_TTL_MS = 2 * 60_000;

/**
 * The longest a run keeps its lock. Far above any of these runs (seconds to a
 * few minutes); past it the run is taken for hung and given up. A job whose
 * runs honestly take longer passes its own `maxHoldMs`.
 */
export const RUN_LOCK_MAX_HOLD_MS = 30 * 60_000;

/** How long a run started by a request waits for a run already under way. */
export const RUN_WAIT_MS = 30_000;

/** Long enough to outlast a lock left behind by a process that died mid-run. */
export const RUN_WAIT_PAST_DEAD_HOLDER_MS = RUN_LOCK_TTL_MS + RUN_WAIT_MS;

const POLL_MS = 500;

/** The run lock of `job` — the lease name every run of that job's work takes. */
export const runLockName = (job: string): string => `${job}-run`;

export interface ExclusiveRunOptions {
  /**
   * How long to wait for a run already under way before giving up. The
   * default, 0, gives up at once: right for a timer's tick, wrong for a run
   * started because something changed. A tick that gives up is skipped, not
   * postponed: its next one comes after the job's interval.
   */
  readonly waitMs?: number;
  /** Tests only: the lock's ttl. */
  readonly ttlMs?: number;
  /** The longest the run is waited for before it is given up. Default RUN_LOCK_MAX_HOLD_MS. */
  readonly maxHoldMs?: number;
  readonly log?: LeaseLogger;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Run `fn` as the only run of `job`'s work, on any replica. `ran: false` means
 * another run was still under way when the wait ended and `fn` was not called.
 * A failure of `fn` is thrown, never reported as "did not run".
 */
export async function runExclusive<T>(
  db: LeaseDb,
  job: string,
  fn: () => Promise<T>,
  opts: ExclusiveRunOptions = {},
): Promise<LeaseOutcome<T>> {
  const deadline = performance.now() + Math.max(0, opts.waitMs ?? 0);
  for (;;) {
    const outcome = await withSchedulerLease(db, runLockName(job), opts.ttlMs ?? RUN_LOCK_TTL_MS, fn, {
      release: true,
      maxHoldMs: opts.maxHoldMs ?? RUN_LOCK_MAX_HOLD_MS,
      log: opts.log,
    });
    if (outcome.ran) return outcome;
    const left = deadline - performance.now();
    if (left <= 0) return outcome;
    await sleep(Math.min(POLL_MS, left));
  }
}

/**
 * Whether a run of `job`'s work is under way right now, on any replica — for
 * a status display. Not a claim: by the time the answer is read it may be old.
 */
export async function isRunUnderWay(db: LeaseDb, job: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM platform_settings
     WHERE setting_key = ${`${SCHEDULER_LEASE_KEY_PREFIX}${runLockName(job)}`}
       AND pg_input_is_valid(setting_value, 'jsonb')
       AND pg_input_is_valid(setting_value::jsonb ->> 'until', 'timestamptz')
       AND (setting_value::jsonb ->> 'until')::timestamptz > now()
  `) as unknown as { rows?: unknown[] };
  return (res.rows ?? []).length > 0;
}

/**
 * For a request whose answer is the run's result: wait for a run under way,
 * then run — or answer 409 when the job is still busy after the wait. `what`
 * names the job for the person reading the error ("The node health check").
 */
export async function runExclusiveOrBusy<T>(
  db: LeaseDb,
  job: string,
  what: string,
  fn: () => Promise<T>,
  opts: ExclusiveRunOptions = {},
): Promise<T> {
  const run = await runExclusive(db, job, fn, { waitMs: RUN_WAIT_MS, ...opts });
  if (!run.ran) throw jobAlreadyRunning(what, job);
  return run.value;
}

/**
 * The 409 a request gets when the job is still running after its wait. It
 * carries the operator-facing wording the panels render, and says the one
 * thing the person needs to know: this request started nothing.
 */
export function jobAlreadyRunning(what: string, job: string): ApiError {
  const detail = `${what} is already running, started by its schedule or by another request.`;
  const operatorError: OperatorError = {
    code: 'JOB_ALREADY_RUNNING',
    title: 'Already running',
    detail,
    remediation: ['Nothing was started by this request. Wait for the run under way to finish, then try again.'],
    retryable: true,
  };
  return new ApiError('JOB_ALREADY_RUNNING', `${detail} Try again in a moment.`, 409, { job, operatorError });
}
