/**
 * Finish lifecycle transitions whose process is gone.
 *
 * A transition runs its hooks one after the other in the API process, under a
 * liveness lock (registry/transition-lock.ts). A deploy, a crash or a lost
 * node ends the process between two hooks; the row then says `running` with
 * the rest of its hooks `pending`, and nothing takes those up — the retry
 * scheduler only retries hooks that failed. What that leaves depends on the
 * kind: a tenant that reads suspended with its site still answering, a tenant
 * whose mail and DNS are deleted and whose row is not.
 *
 * This leg finds those and runs the hooks that had not ended. A delete is
 * taken to its end — namespace and row — because half of it cannot be taken
 * back, and the operator who asked for it was told it had begun. Its
 * transition is held open until the row is gone (cascades.ts), so one cut
 * off after its last hook is found here as well.
 *
 * How often a transition was finished is counted by the dispatcher, under the
 * transition's lock: a look that found the lock held has not run it.
 *
 * Not everything found is finished:
 *
 *   - a transition whose tenant is owned by a storage operation in flight is
 *     that operation's: an archive, a restore, a suspend and a resume finish
 *     their own cascades when they are picked up (storage-lifecycle/);
 *   - one the tenant has since moved past — any later transition exists — is
 *     closed, not finished. Its remaining hooks would put a tenant that was
 *     resumed in the meantime half back into suspension;
 *   - one that belonged to a storage operation which has since ended as
 *     failed — given up after too many pick-ups, cancelled, abandoned — is
 *     closed: the operator was told that operation failed, and an archive's
 *     hooks finished afterwards would archive the tenant all the same;
 *   - a decommission's — recorded as a delete that keeps the tenant — is
 *     closed: its hooks are a delete's, and the rest of a decommission is not
 *     this leg's to run;
 *   - one older than the age rule, or picked up as often as allowed and cut
 *     off each time, is closed too.
 *
 * Closed means: the transition ends `failed_partial` and the hooks that never
 * ran are marked failed with the reason, where the operator sees them.
 *
 * "Gone" is read from the lock, as for a storage operation
 * (storage-lifecycle/interrupted-ops.ts): the lock lapsed a minute or more
 * ago, or there is none minutes after the transition began — an older
 * release's, which wrote no lock, and is touched only once every API process
 * is this release.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenantLifecycleHookRuns, tenantLifecycleTransitions } from '../../db/schema.js';
import { SCHEDULER_LEASE_KEY_PREFIX } from '../../shared/scheduler-lease.js';
import { runExclusive, runLockName } from '../../shared/exclusive-run.js';
import { everyApiProcessIsThisRelease } from '../../shared/api-release.js';
import { runTransition, type Transition } from './registry/index.js';
import { TRANSITION_MAX_HOLD_MS, transitionLockJob, underTransitionLock } from './registry/transition-lock.js';
import { TENANT_LOCK_MAX_HOLD_MS, tenantLockJob } from './tenant-lock.js';

/** How long a lock must have been lapsed before its holder is taken for dead. */
export const DEAD_HOLDER_GRACE_MS = 60_000;

/** How long a transition with no lock at all is left alone. */
export const UNLOCKED_GRACE_MS = 3 * 60_000;

/** How often a transition is picked up again before it is closed. */
export const TRANSITION_MAX_RESUMES = 3;

/** A hook run by the retry scheduler that has said `running` this long has nobody behind it. */
export const RETRY_RUN_DEAD_AFTER_MS = 30 * 60_000;

export interface InterruptedTransition {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: Transition;
  readonly toStatus: string;
  readonly triggeredByUserId: string | null;
  /** As captured when it began, or the tenant's now; null when neither is known. */
  readonly namespace: string | null;
  /** No lock row at all, as opposed to one that lapsed. */
  readonly unlocked: boolean;
  readonly tenantExists: boolean;
  /** The tenant has been through a later transition. */
  readonly superseded: boolean;
  /** Older than the age rule. */
  readonly tooOld: boolean;
  /** How often it has been picked up already. */
  readonly resumes: number;
  /**
   * A delete of the tenant itself: it ends with the namespace and the row
   * gone. A decommission is recorded as a `deleted` transition too, and keeps
   * both (k8s-provisioner, `preservedTenant`).
   */
  readonly hardDelete: boolean;
  /** It began inside a storage operation of the tenant that has since ended as failed. */
  readonly ownerFailed: boolean;
}

export interface TransitionPickUpResult {
  /** Transitions whose remaining hooks were run. */
  readonly finished: number;
  /** Transitions closed without running anything. */
  readonly closed: number;
  /** Found without a live process, and left as they are for now. */
  readonly leftAlone: number;
}

interface Row {
  id: string; tenant_id: string; transition_kind: Transition; to_status: string; triggered_by_user_id: string | null;
  namespace: string | null; unlocked: boolean; tenant_exists: boolean; superseded: boolean; too_old: boolean; resumes: number;
  hard_delete: boolean; owner_failed: boolean;
}

/**
 * Transitions that say `running` with no live process behind them, and whose
 * tenant no storage operation owns. `onlyId` asks about one, whatever its
 * lock says — for the look under the lock, just before it is finished.
 */
export async function findInterruptedTransitions(
  db: Database,
  opts: { readonly graceMs?: number; readonly unlockedGraceMs?: number; readonly onlyId?: string } = {},
): Promise<InterruptedTransition[]> {
  const [head, tail] = `${SCHEDULER_LEASE_KEY_PREFIX}${runLockName(transitionLockJob('\u0000'))}`.split('\u0000');
  const graceMs = opts.graceMs ?? DEAD_HOLDER_GRACE_MS;
  const unlockedGraceMs = opts.unlockedGraceMs ?? UNLOCKED_GRACE_MS;
  const gone = opts.onlyId
    ? sql`tr.id = ${opts.onlyId}`
    : sql`CASE
            WHEN l.setting_key IS NULL
              THEN tr.started_at < now() - (${unlockedGraceMs} || ' milliseconds')::interval
            WHEN NOT pg_input_is_valid(l.setting_value, 'jsonb') THEN false
            WHEN NOT pg_input_is_valid(l.setting_value::jsonb ->> 'until', 'timestamptz') THEN false
            ELSE (l.setting_value::jsonb ->> 'until')::timestamptz < now() - (${graceMs} || ' milliseconds')::interval
          END`;
  const res = await db.execute(sql`
    SELECT tr.id, tr.tenant_id, tr.transition_kind, tr.to_status, tr.triggered_by_user_id,
           coalesce(tr.namespace, t.kubernetes_namespace) AS namespace,
           (l.setting_key IS NULL) AS unlocked,
           (t.id IS NOT NULL) AS tenant_exists,
           EXISTS (
             SELECT 1 FROM tenant_lifecycle_transitions n
              WHERE n.tenant_id = tr.tenant_id AND n.id <> tr.id AND n.started_at > tr.started_at
           ) AS superseded,
           (tr.started_at < now() - (${TRANSITION_MAX_HOLD_MS} || ' milliseconds')::interval) AS too_old,
           CASE WHEN jsonb_typeof(tr.detail -> 'resumes') = 'number' THEN (tr.detail ->> 'resumes')::int ELSE 0 END AS resumes,
           (tr.transition_kind = 'deleted' AND tr.to_status = 'deleted'
             AND coalesce(tr.detail ->> 'preservedTenant', 'false') <> 'true') AS hard_delete,
           EXISTS (
             SELECT 1 FROM storage_operations own
              WHERE own.tenant_id = tr.tenant_id
                AND own.state = 'failed'
                AND own.created_at <= tr.started_at
                AND (own.completed_at IS NULL OR own.completed_at >= tr.started_at)
           ) AS owner_failed
      FROM tenant_lifecycle_transitions tr
      LEFT JOIN tenants t ON t.id = tr.tenant_id
      LEFT JOIN platform_settings l ON l.setting_key = ${head} || tr.id::text || ${tail}
     WHERE tr.state = 'running'
       AND NOT EXISTS (
             SELECT 1 FROM storage_operations op
              WHERE op.id = t.active_storage_op_id AND op.state NOT IN ('idle', 'failed')
           )
       AND ${gone}
     ORDER BY tr.started_at
     LIMIT 50
  `) as unknown as { rows?: Row[] };
  return (res.rows ?? []).map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.transition_kind,
    toStatus: r.to_status,
    triggeredByUserId: r.triggered_by_user_id,
    namespace: r.namespace,
    unlocked: r.unlocked === true,
    tenantExists: r.tenant_exists === true,
    superseded: r.superseded === true,
    tooOld: r.too_old === true,
    resumes: Number(r.resumes) || 0,
    hardDelete: r.hard_delete === true,
    ownerFailed: r.owner_failed === true,
  }));
}

const INTERRUPTED = 'Interrupted: the platform API restarted while this transition was running.';

/** Why a transition is closed instead of finished; null when it is to be finished. */
export function whyNotFinished(tr: InterruptedTransition): string | null {
  if (tr.superseded) return `${INTERRUPTED} The tenant has been through a later transition since, so this one was not finished.`;
  if (tr.ownerFailed) return `${INTERRUPTED} The storage operation it belonged to has ended as failed, so it was not finished.`;
  if (tr.kind === 'deleted' && !tr.hardDelete) return `${INTERRUPTED} It belongs to a decommission, which is not picked up again: start the decommission again.`;
  if (tr.tooOld) return `${INTERRUPTED} It was found too long after to be finished safely.`;
  if (tr.resumes >= TRANSITION_MAX_RESUMES) return `${INTERRUPTED} It was picked up again more than once and interrupted each time, so it was not tried again.`;
  if (!tr.namespace) return `${INTERRUPTED} Its tenant's namespace is no longer known, so its remaining hooks could not be run.`;
  if (!tr.tenantExists && tr.kind !== 'deleted') return `${INTERRUPTED} Its tenant no longer exists.`;
  return null;
}

/**
 * Close a transition without running anything: it ends `failed_partial`, and
 * the hooks that never ended are failed with the reason and not retried.
 * Under the transition's lock, so one that is being run after all is never
 * closed under its feet. False when it was not closed.
 */
export async function closeInterruptedTransition(db: Database, id: string, why: string): Promise<boolean> {
  const run = await underTransitionLock(db, id, async () => {
    const now = new Date();
    const closed = await db.update(tenantLifecycleTransitions)
      .set({ state: 'failed_partial', completedAt: now })
      .where(and(eq(tenantLifecycleTransitions.id, id), eq(tenantLifecycleTransitions.state, 'running')))
      .returning({ id: tenantLifecycleTransitions.id });
    if (closed.length === 0) return false;
    await db.update(tenantLifecycleHookRuns)
      .set({ state: 'failed', completedAt: now, nextAttemptAt: null, lastError: { title: 'Interrupted', detail: why } })
      .where(and(eq(tenantLifecycleHookRuns.transitionId, id), inArray(tenantLifecycleHookRuns.state, ['pending', 'running'])));
    try {
      const { finishByRef } = await import('../tasks/service.js');
      await finishByRef(db, 'tenant.transition', id, { status: 'failed', text: null, error: why });
    } catch { /* the chip is a convenience; the transition is closed either way */ }
    return true;
  });
  return run.ran && run.value;
}

/**
 * Run what is left of one transition. Under the tenant's lock, where anything
 * that starts a change to the tenant is — so a new suspend, or a delete, is
 * never begun beside it — and after looking again: the process that was only
 * slow may have ended it meanwhile.
 */
async function finishTransition(db: Database, k8s: K8sClients, found: InterruptedTransition): Promise<'finished' | 'closed' | 'left'> {
  let outcome: 'closed' | 'left' = 'left';
  /** The look under the lock. Null when the transition is not this pick-up's to finish. */
  const claim = async (): Promise<InterruptedTransition | null> => {
    const [tr] = await findInterruptedTransitions(db, { onlyId: found.id });
    if (!tr) return null;
    const why = whyNotFinished(tr);
    if (why) {
      if (await closeInterruptedTransition(db, tr.id, why)) outcome = 'closed';
      return null;
    }
    return tr;
  };

  if (found.hardDelete && found.tenantExists) {
    // The delete takes the tenant's lock itself (tenants/service.ts), and ends
    // with the namespace and the row gone — as the operator asked.
    const { finishInterruptedDelete } = await import('../tenants/service.js');
    const deleted = await finishInterruptedDelete(db, found.tenantId, k8s, found.triggeredByUserId, async () => {
      const tr = await claim();
      return tr?.hardDelete && tr.tenantExists ? tr.id : null;
    });
    return deleted ? 'finished' : outcome;
  }

  const run = await runExclusive(db, tenantLockJob(found.tenantId), async (): Promise<'finished' | 'closed' | 'left'> => {
    const tr = await claim();
    if (!tr) return outcome;
    const done = await runTransition(db, k8s, {
      tenantId: tr.tenantId,
      namespace: tr.namespace as string,
      transition: tr.kind,
      toStatus: tr.toStatus,
      triggeredByUserId: tr.triggeredByUserId,
      resumeTransitionId: tr.id,
    });
    return done.state === 'running' ? 'left' : 'finished';
  }, { maxHoldMs: TENANT_LOCK_MAX_HOLD_MS });
  return run.ran ? run.value : 'left';
}

export async function pickUpInterruptedTransitions(
  db: Database,
  k8s: K8sClients,
  platformNamespace: string = process.env.PLATFORM_NAMESPACE ?? 'platform',
  log: (line: string) => void = (line) => { console.warn(`[interrupted-transitions] ${line}`); },
): Promise<TransitionPickUpResult> {
  const interrupted = await findInterruptedTransitions(db);
  let finished = 0;
  let closed = 0;
  let leftAlone = 0;
  // Asked once, and only when a transition without a lock was found.
  let oneRelease: Promise<boolean | null> | null = null;

  for (const tr of interrupted) {
    const name = `${tr.kind} transition ${tr.id} of tenant ${tr.tenantId}`;
    try {
      if (tr.unlocked) {
        oneRelease ??= everyApiProcessIsThisRelease(k8s, platformNamespace);
        if ((await oneRelease) !== true) {
          leftAlone += 1;
          log(`${name} has no lock, and an API process of another release may be running it — left alone`);
          continue;
        }
      }
      const outcome = await finishTransition(db, k8s, tr);
      if (outcome === 'finished') {
        finished += 1;
        log(`${name} had no live process behind it — its remaining hooks were run`);
      } else if (outcome === 'closed') {
        closed += 1;
        log(`${name} had no live process behind it and was closed without running its remaining hooks`);
      } else {
        leftAlone += 1;
      }
    } catch (err) {
      leftAlone += 1;
      log(`${name} could not be finished: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { finished, closed, leftAlone };
}

/**
 * Hand a hook back to the retry scheduler that it was running when its
 * process died. The scheduler marks a hook `running` for the length of a
 * retry; one cut off there stays `running` under a transition that has long
 * ended, and is never retried again — the scheduler takes `failed` rows only.
 *
 * Only under a transition that is not itself running: there the hook is the
 * dispatcher's, and the pick-up above finishes it. Returns how many.
 */
export async function requeueInterruptedRetries(db: Database, deadAfterMs: number = RETRY_RUN_DEAD_AFTER_MS): Promise<number> {
  const res = await db.execute(sql`
    UPDATE tenant_lifecycle_hook_runs hr
       SET state = 'failed',
           completed_at = now(),
           next_attempt_at = CASE WHEN hr.attempts < hr.max_attempts THEN now() ELSE NULL END,
           last_error = ${JSON.stringify({ title: 'Interrupted', detail: 'The platform API restarted while this hook was being retried.' })}::jsonb
      FROM tenant_lifecycle_transitions tr
     WHERE tr.id = hr.transition_id
       AND tr.state <> 'running'
       AND hr.state = 'running'
       AND hr.started_at < now() - (${deadAfterMs} || ' milliseconds')::interval
    RETURNING hr.id
  `) as unknown as { rows?: unknown[] };
  return (res.rows ?? []).length;
}
