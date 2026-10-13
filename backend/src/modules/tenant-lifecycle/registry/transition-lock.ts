/**
 * The lock a process holds for as long as it is running a transition's hooks.
 *
 * A transition is a row that says `running` and a list of hooks, run one after
 * the other in the API process. A deploy, a crash or a lost node ends that
 * process between two of them — and the row goes on saying `running` with the
 * rest of its hooks `pending`, for ever: the retry scheduler only takes up
 * hooks that failed. A suspend then leaves a tenant whose status reads
 * suspended and whose site still answers; a delete leaves one whose mail is
 * gone and whose row is not.
 *
 * The lock is what tells a transition that is being run from one that was cut
 * off: a live run renews it, a dead one's lapses within minutes, and the
 * pick-up (interrupted-transitions.ts) finishes the transition.
 */
import { runExclusive } from '../../../shared/exclusive-run.js';
import type { LeaseDb, LeaseOutcome } from '../../../shared/scheduler-lease.js';

/** The run-lock job of one transition. */
export const transitionLockJob = (transitionId: string): string => `lifecycle-transition:${transitionId}`;

/**
 * The longest a transition's lock is held before its run is given up as hung.
 * Hooks are bounded in seconds or minutes; this is the storage operations'
 * rule (op-lock.ts), so one age decides "abandoned" for both.
 */
export const TRANSITION_MAX_HOLD_MS = 6 * 60 * 60_000;

/** Run `fn` as the only run of this transition's hooks. `ran: false` when another process is running them. */
export function underTransitionLock<T>(db: LeaseDb, transitionId: string, fn: () => Promise<T>): Promise<LeaseOutcome<T>> {
  return runExclusive(db, transitionLockJob(transitionId), fn, { maxHoldMs: TRANSITION_MAX_HOLD_MS });
}
