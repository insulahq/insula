/**
 * Pick up storage operations whose process is gone.
 *
 * A resize, a restore, a filesystem check and an archive run detached, in the
 * API process, under a liveness lock (op-lock.ts) that the process renews
 * while it works. A deploy, a crash or a lost node ends the process in the
 * middle; the lock then lapses, and the operation row goes on saying
 * "restoring" with nobody behind it — and its tenant scaled to zero. This leg
 * of the watchdog finds those and starts them again: every one of them can be
 * run a second time from the top (service.ts, `resumeOperation`).
 *
 * Started again, not ended, because ending is not harmless. A shrink cut off
 * after the old volume was deleted has its files in the bundle only; "failed,
 * workloads started" there is a tenant running on an empty volume.
 *
 * A suspend and a resume run under the tenant's lock instead of one of their
 * own, and are finished the same way under that lock: one cut off among its
 * cascades has a tenant that reads suspended with its site still up, or the
 * reverse, and cannot simply be asked for again.
 *
 * "Gone" is read from the lock:
 *
 *   - the lock's row is there and lapsed a minute or more ago. A process that
 *     ends its operation deletes the row; one that dies leaves it to lapse.
 *     The minute is for a holder that was late renewing, not dead.
 *   - no row at all, minutes after the operation began. Every operation this
 *     release starts runs under its lock, so one without is an older release's
 *     — which wrote no lock for these — or one whose own ending failed. An
 *     older release's process may still be alive during an upgrade, and then
 *     it is working on it: such an operation is touched only once every API
 *     process is this release (`everyApiProcessIsThisRelease`). One whose
 *     starter never got the lock, and told its caller so, is not run at all:
 *     its claim is withdrawn.
 *
 * An operation older than the watchdog's age rule is never picked up here:
 * its lock was given up as hung, and the work may still be going on.
 *
 * Picking up takes the lock, so two watchdogs — or a watchdog and a holder
 * that was only slow — cannot both run the operation.
 */
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { SCHEDULER_LEASE_KEY_PREFIX } from '../../shared/scheduler-lease.js';
import { runExclusive, runLockName } from '../../shared/exclusive-run.js';
import { tenantLockJob } from '../tenant-lifecycle/tenant-lock.js';
import { OP_MAX_HOLD_MS, opLockJob } from './op-lock.js';
import { resumeOperation, resumeTransitionOp, updateOp, type ResumeOutcome } from './service.js';
import { everyApiProcessIsThisRelease } from '../../shared/api-release.js';
import { endAbandonedOperation } from './quiesce-watchdog.js';
import { storageOperations, tenants } from '../../db/schema.js';

/** How long a lock must have been lapsed before its holder is taken for dead. */
export const DEAD_HOLDER_GRACE_MS = 60_000;

/**
 * How long an operation with no lock at all is left alone. A starter writes
 * its claim and takes the lock a moment later; this is far beyond that moment.
 */
export const UNLOCKED_GRACE_MS = 3 * 60_000;

/** The kinds this leg knows what to do with. A move has its own rule (quiesce-watchdog.ts). */
const DETACHED_KINDS = ['archive', 'resize', 'restore', 'fsck'] as const;
const UNDER_TENANT_LOCK_KINDS = ['suspend', 'resume'] as const;

export { everyApiProcessIsThisRelease, everyPodRunsTheSameRelease } from '../../shared/api-release.js';

export interface InterruptedOperation {
  readonly opId: string;
  readonly opType: string;
  readonly tenantId: string;
  readonly namespace: string;
  /** No lock row at all, as opposed to one that lapsed. */
  readonly unlocked: boolean;
}

export interface PickUpResult {
  /** Operations started again. */
  readonly resumed: number;
  /** Operations ended: one picked up too often already, or one that never began. */
  readonly ended: number;
  /** Found without a live process, and left as they are for now. */
  readonly leftAlone: number;
}

/** The `platform_settings` key of a run lock, split where the id goes. */
function lockKeyAround(job: (id: string) => string): [string, string] {
  const [head, tail] = `${SCHEDULER_LEASE_KEY_PREFIX}${runLockName(job('\u0000'))}`.split('\u0000');
  return [head, tail];
}

/**
 * Operations in flight with no live process behind them: their lock lapsed at
 * least `graceMs` ago, or they have had no lock for `unlockedGraceMs`.
 */
export async function findInterruptedOperations(
  db: Database,
  graceMs: number = DEAD_HOLDER_GRACE_MS,
  unlockedGraceMs: number = UNLOCKED_GRACE_MS,
): Promise<InterruptedOperation[]> {
  const [opHead, opTail] = lockKeyAround(opLockJob);
  const [tenantHead, tenantTail] = lockKeyAround(tenantLockJob);
  const kinds = [...DETACHED_KINDS, ...UNDER_TENANT_LOCK_KINDS];
  const res = await db.execute(sql`
    SELECT op.id, op.op_type, op.tenant_id, t.kubernetes_namespace AS namespace, (l.setting_key IS NULL) AS unlocked
      FROM storage_operations op
      JOIN tenants t ON t.id = op.tenant_id AND t.active_storage_op_id = op.id
      LEFT JOIN platform_settings l ON l.setting_key = CASE
             WHEN op.op_type::text IN (${sql.join(UNDER_TENANT_LOCK_KINDS.map((k) => sql`${k}`), sql`, `)})
               THEN ${tenantHead} || op.tenant_id::text || ${tenantTail}
             ELSE ${opHead} || op.id::text || ${opTail}
           END
     WHERE op.op_type::text IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
       AND op.state NOT IN ('idle', 'failed')
       AND CASE
             WHEN l.setting_key IS NULL
               THEN op.created_at < now() - (${unlockedGraceMs} || ' milliseconds')::interval
                AND op.created_at > now() - (${OP_MAX_HOLD_MS} || ' milliseconds')::interval
             WHEN NOT pg_input_is_valid(l.setting_value, 'jsonb') THEN false
             WHEN NOT pg_input_is_valid(l.setting_value::jsonb ->> 'until', 'timestamptz') THEN false
             ELSE (l.setting_value::jsonb ->> 'until')::timestamptz < now() - (${graceMs} || ' milliseconds')::interval
           END
     ORDER BY op.created_at
  `) as unknown as { rows?: Array<{ id: string; op_type: string; tenant_id: string; namespace: string; unlocked: boolean }> };
  return (res.rows ?? []).map((r) => ({
    opId: r.id, opType: r.op_type, tenantId: r.tenant_id, namespace: r.namespace, unlocked: r.unlocked === true,
  }));
}

const INTERRUPTED = 'Interrupted: the platform API restarted while this was running.';

/**
 * End a suspend or a resume that was picked up as often as an operation is and
 * cut off each time, the way its own failure ends it: the operation failed,
 * the tenant free for the next one. Under the tenant's lock, where a live
 * suspend or resume would be — so one that is running after all is never
 * ended under its feet. False when it was not ended.
 */
async function endInterruptedTransition(db: Database, op: InterruptedOperation): Promise<boolean> {
  const run = await runExclusive(db, tenantLockJob(op.tenantId), async () => {
    const [still] = await db.select({ id: storageOperations.id })
      .from(storageOperations)
      .innerJoin(tenants, and(eq(tenants.id, storageOperations.tenantId), eq(tenants.activeStorageOpId, storageOperations.id)))
      .where(and(eq(storageOperations.id, op.opId), notInArray(storageOperations.state, ['idle', 'failed'])));
    if (!still) return false;
    const what = op.opType === 'suspend' ? 'suspended' : 'resumed';
    await updateOp(db, op.opId, {
      state: 'failed',
      completedAt: new Date(),
      lastError: `${INTERRUPTED} It was picked up again more than once and interrupted each time, so it was ended here. `
        + `The tenant may be only partly ${what}: check its status, then ${op.opType === 'suspend' ? 'resume and suspend' : 'suspend and resume'} it again.`,
    });
    await db.update(tenants)
      .set({ storageLifecycleState: 'idle', activeStorageOpId: null })
      .where(and(eq(tenants.id, op.tenantId), eq(tenants.activeStorageOpId, op.opId)));
    return true;
  });
  return run.ran && run.value;
}

export async function pickUpInterruptedOperations(
  db: Database,
  k8s: K8sClients,
  config: Record<string, unknown>,
  log: (line: string) => void = (line) => { console.warn(`[interrupted-ops] ${line}`); },
): Promise<PickUpResult> {
  const interrupted = await findInterruptedOperations(db);
  let resumed = 0;
  let ended = 0;
  let leftAlone = 0;
  // Asked once, and only when an operation without a lock was found.
  let oneRelease: Promise<boolean | null> | null = null;
  const platformNamespace = (config.PLATFORM_NAMESPACE as string | undefined) ?? 'platform';

  for (const op of interrupted) {
    const name = `${op.opType} ${op.opId}`;
    try {
      if (op.unlocked) {
        oneRelease ??= everyApiProcessIsThisRelease(k8s, platformNamespace);
        if ((await oneRelease) !== true) {
          leftAlone += 1;
          log(`${name} has no lock, and an API process of another release may be running it — left alone`);
          continue;
        }
      }
      const underTenantLock = (UNDER_TENANT_LOCK_KINDS as readonly string[]).includes(op.opType);
      const outcome: ResumeOutcome = underTenantLock
        ? await resumeTransitionOp({ db, k8s }, op.opId)
        : await resumeOperation({ db, k8s }, op.opId);
      if (outcome === 'resumed') {
        resumed += 1;
        log(`${name} had no live process behind it — picked up again`);
      } else if (outcome === 'withdrawn') {
        ended += 1;
        log(`${name} never began — its starter did not get the lock — and its claim was withdrawn`);
      } else if (outcome === 'spent' && underTenantLock) {
        if (await endInterruptedTransition(db, op)) {
          ended += 1;
          log(`${name} had no live process behind it and was ended (picked up too often)`);
        } else {
          leftAlone += 1;
        }
      } else if (outcome === 'spent' || outcome === 'unknown') {
        const why = outcome === 'spent'
          ? `${INTERRUPTED} It was picked up again more than once and interrupted each time, so it was ended here.`
          : `${INTERRUPTED} It could not be picked up again.`;
        if (await endAbandonedOperation(db, k8s, op.opId, `${why} The tenant's workloads were started again; check the tenant before starting the operation again.`)) {
          ended += 1;
          log(`${name} had no live process behind it and was ended (${outcome === 'spent' ? 'picked up too often' : 'nothing knows how to run it again'})`);
        } else {
          leftAlone += 1;
        }
      } else {
        leftAlone += 1;
      }
    } catch (err) {
      leftAlone += 1;
      log(`${name} could not be picked up again: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { resumed, ended, leftAlone };
}
