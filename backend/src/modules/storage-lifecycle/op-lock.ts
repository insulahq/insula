/**
 * The lock a process holds for as long as it is working on a storage operation.
 *
 * A resize, a restore, a filesystem check and an archive run detached from the
 * request that started them, in the API process — and a deploy, a crash or a
 * node loss ends that process in the middle. The operation row then says
 * "restoring" for ever and nothing is working on it. The lock is what tells
 * the two apart: a live operation renews it, a dead one's lapses within
 * minutes, and the watchdog (interrupted-ops.ts) picks the operation up again.
 * Before, such an operation waited six hours to be marked failed, and its
 * tenant stayed scaled to zero until then.
 *
 * The lock is a lease, so "lapsed" does not prove "dead": a process paused for
 * minutes — a stalled VM, a database out of reach — looks the same from
 * outside. An operation therefore asks before every step that writes or
 * deletes whether the lock is still its own (`stillMine`), and stops where it
 * is when it is not, without failing the operation or touching the workloads.
 * What that leaves open is a stall between one such question and the action
 * after it.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { runExclusive, runLockName } from '../../shared/exclusive-run.js';
import { REPLICA_ID, SCHEDULER_LEASE_KEY_PREFIX } from '../../shared/scheduler-lease.js';

/** The run-lock job of one storage operation. */
export const opLockJob = (opId: string): string => `storage-op:${opId}`;

/** As long as the watchdog gives any operation before it calls it abandoned. */
export const OP_MAX_HOLD_MS = 6 * 60 * 60 * 1000;

/** How often an interrupted operation is picked up again before it is ended. */
export const OP_MAX_RESUMES = 3;

/**
 * Thrown inside an operation that finds its lock is no longer its own: the
 * process stalled for longer than the lock lasts, and another one has picked
 * the operation up — or the watchdog has ended it. The run stops where it is
 * and touches nothing more, not the operation's row and not the tenant's
 * workloads: all of that is its successor's now.
 */
export class OperationTakenOver extends Error {
  constructor(opId: string) {
    super(`storage operation ${opId} is no longer this process's to run`);
    this.name = 'OperationTakenOver';
  }
}

/**
 * Run an operation detached from its caller, under its liveness lock. Resolves
 * as soon as it is known whether it began: true — this process holds the lock
 * and the operation is running; false — another process holds it. Rejects when
 * the lock could not even be asked for. `onceMine` runs first, under the lock.
 */
export function launchOp(
  db: Database,
  opId: string,
  run: () => Promise<void>,
  onceMine?: () => Promise<void>,
): Promise<boolean> {
  return launchUnder(db, opLockJob(opId), OP_MAX_HOLD_MS, async () => {
    await onceMine?.();
    await run();
  });
}

/**
 * `launchOp` for a run that belongs under another lock than its operation's —
 * a suspend or a resume, which hold their tenant's (tenant-lock.ts).
 */
export function launchUnder(
  db: Database,
  job: string,
  maxHoldMs: number,
  run: () => Promise<void>,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let began = false;
    runExclusive(db, job, async () => {
      began = true;
      resolve(true);
      await run();
    }, { maxHoldMs }).then((outcome) => {
      if (!outcome.ran) resolve(false);
    }, (err: unknown) => {
      if (!began) reject(err instanceof Error ? err : new Error(String(err)));
      else console.error(`[storage-lifecycle] the run under ${job} ended outside its own handling:`, err);
    });
  });
}

/**
 * Whether the operation is still this process's to run: its lock carries this
 * process's name, and the operation has not ended.
 *
 * The second half is not implied by the first. A lock is deleted when its run
 * ends, and a run renews its lock by writing it again if the row is gone — so
 * a process that stalled, and wakes after its successor has finished the
 * operation and let the lock go, would simply take the lock back. An
 * operation that reads idle or failed is nobody's to run, whoever holds what.
 */
export async function operationIsMine(db: Database, opId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1
      FROM platform_settings l
      JOIN storage_operations op ON op.id = ${opId} AND op.state NOT IN ('idle', 'failed')
     WHERE l.setting_key = ${`${SCHEDULER_LEASE_KEY_PREFIX}${runLockName(opLockJob(opId))}`}
       AND pg_input_is_valid(l.setting_value, 'jsonb')
       AND (l.setting_value::jsonb ->> 'holder') = ${REPLICA_ID}::text
  `) as unknown as { rows?: unknown[] };
  return (res.rows ?? []).length > 0;
}

export interface OpGuard {
  /**
   * Asked before every step that writes or deletes: a process that stalled
   * past its lock's lifetime wakes up in mid-run, and by then another one may
   * be running this operation, or have finished it, or an operator may have
   * cancelled it. Throws OperationTakenOver.
   */
  readonly stillMine: () => Promise<void>;
  /**
   * For the operation's failure path: whether what went wrong is this
   * process's to record. Not when the operation went to another — whatever
   * failed then (a helper Job removed by the process that took over, most
   * likely) is not the operation failing, and marking it failed or bringing
   * the workloads back would do both under the successor's feet. An ownership
   * that cannot be read counts as lost too: the lock then lapses, and the
   * operation is picked up.
   */
  readonly failureIsMine: (err: unknown) => Promise<boolean>;
}

export function opGuard(db: Database, opId: string): OpGuard {
  return {
    stillMine: async () => {
      if (!(await operationIsMine(db, opId))) throw new OperationTakenOver(opId);
    },
    failureIsMine: async (err) => {
      const mine = !(err instanceof OperationTakenOver)
        && await operationIsMine(db, opId).catch(() => false);
      if (!mine) {
        console.warn(`[storage-lifecycle] operation ${opId}: stopped here, it is no longer this process's to run (${err instanceof Error ? err.message : String(err)})`);
      }
      return mine;
    },
  };
}
