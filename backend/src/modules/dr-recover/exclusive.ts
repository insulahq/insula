/**
 * One recovery per tenant, one batch at a time — enforced in the database.
 *
 * "Is one running? If not, start one" is a check-then-insert: run it on two
 * API replicas at once (or a double click, or a retried request) and both
 * checks pass. So the reap, every check and the INSERT run in ONE transaction
 * holding an advisory lock keyed on the tenant (`dr.recover:<tenantId>`) or on
 * the batch (`dr.recover-all`): concurrent starts serialise, and the second
 * sees the first's committed row.
 *
 * Under the lock, before enrolling:
 *  1. Runs that stopped heartbeating are failed (DB clock — ./liveness.ts).
 *  2. A live run of this tenant refuses the start (409).
 *  3. A restore cart of this tenant still `executing` refuses it too — a
 *     recovery would build a second restore on top of one in flight. When that
 *     cart's own recovery already ended (its process died mid-restore — the
 *     cart can never finish), the cart is marked failed and the start is
 *     refused ONCE, saying the tenant holds a partial restore; starting again
 *     is then a deliberate re-apply.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { toSafeText, type DrRecoverTaskDetails, type OperatorError } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { restoreItems, restoreJobs, tasks } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import * as taskService from '../tasks/service.js';
import { ABANDONED_MESSAGE, STALE_AFTER_SECONDS } from './liveness.js';
import { initialSteps } from './task-reporter.js';

export const DR_RECOVER_TASK_KIND = 'dr.recover';
export const DR_RECOVER_ALL_TASK_KIND = 'dr.recover-all';

const ABANDONED_ERROR: OperatorError = {
  code: 'DR_RECOVER_ABANDONED',
  title: 'The recovery stopped reporting progress',
  detail: 'The platform-api process running it was restarted, so it did not finish.',
  remediation: ['Check the tenant, then start the recovery again.'],
  retryable: true,
};

const CART_ABANDONED = 'ABANDONED: the process applying this restore was restarted before it finished';

function utcMinute(value: Date | string | null): string {
  if (!value) return 'an unknown time';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'an unknown time' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function refusal(code: string, message: string, details: Record<string, unknown>, operatorError: Omit<OperatorError, 'code'>): ApiError {
  return new ApiError(code, message, 409, { ...details, operatorError: { code, ...operatorError } });
}

export function recoveryInProgress(tenantId: string): ApiError {
  return refusal('DR_RECOVER_IN_PROGRESS', 'A recovery of this tenant is already running.', { tenantId }, {
    title: 'Already being recovered',
    detail: 'A recovery of this tenant is already running. Two at once would restore over each other.',
    remediation: ['Follow the running recovery from the task center, and start another only once it has finished.'],
    retryable: false,
  });
}

function restoreStillExecuting(tenantId: string, cart: { id: string; startedAt: Date | null }): ApiError {
  return refusal(
    'DR_RESTORE_IN_PROGRESS',
    `Restore ${cart.id} of this tenant is still executing; a recovery now would stack a second restore on it.`,
    { tenantId, cartId: cart.id },
    {
      title: 'A restore of this tenant is still running',
      detail: `Restore ${cart.id} has been applying since ${utcMinute(cart.startedAt)}. A recovery now would build a second restore on top of it.`,
      remediation: [
        'Wait for it to finish — its items show on the tenant\'s restore carts.',
        'If it has not advanced for a long time, the process applying it was restarted and it can no longer finish; it must then be marked failed in the database before a new recovery can run.',
      ],
      retryable: true,
    },
  );
}

function previousRecoveryIncomplete(tenantId: string, cartId: string, done: number, total: number): ApiError {
  return refusal(
    'DR_PREVIOUS_RECOVERY_INCOMPLETE',
    `The previous recovery of this tenant stopped while restoring (${done} of ${total} items applied).`,
    { tenantId, cartId, itemsDone: done, itemsTotal: total },
    {
      title: 'The previous recovery of this tenant stopped half-way',
      detail: `Its process was restarted while restoring — restore ${cartId} had applied ${done} of ${total} items. That restore is now marked failed, so the tenant holds a partial restore.`,
      remediation: [
        'Start the recovery again to re-apply everything from the bundle.',
        'Or roll the tenant back to the snapshot taken before that restore, from its restore cart.',
      ],
      retryable: true,
    },
  );
}

/** Mark a cart whose executor is gone as failed. Returns its item tally. */
async function failAbandonedCart(tx: Database, cartId: string): Promise<{ done: number; total: number }> {
  await tx.update(restoreItems)
    .set({ status: 'failed', finishedAt: new Date(), lastError: CART_ABANDONED })
    .where(and(eq(restoreItems.restoreJobId, cartId), eq(restoreItems.status, 'applying')));
  await tx.update(restoreJobs)
    .set({ status: 'failed', finishedAt: new Date(), lastError: CART_ABANDONED })
    .where(and(eq(restoreJobs.id, cartId), eq(restoreJobs.status, 'executing')));
  const items = await tx.select({ status: restoreItems.status }).from(restoreItems).where(eq(restoreItems.restoreJobId, cartId));
  return { done: items.filter((i) => i.status === 'done').length, total: items.length };
}

/**
 * 409 for a restore of `tenantId` still `executing`, or null. A cart whose
 * owning recovery already ended is abandoned: fail it and refuse once.
 */
async function executingRestoreRefusal(tx: Database, tenantId: string): Promise<ApiError | null> {
  const executing = await tx
    .select({ id: restoreJobs.id, startedAt: restoreJobs.startedAt })
    .from(restoreJobs)
    .where(and(eq(restoreJobs.tenantId, tenantId), eq(restoreJobs.status, 'executing')));
  let refusalFound: ApiError | null = null;
  for (const cart of executing) {
    const [owner] = await tx
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(
        eq(tasks.kind, DR_RECOVER_TASK_KIND),
        eq(tasks.tenantId, tenantId),
        sql`${tasks.details}->>'cartId' = ${cart.id}`,
      ))
      .orderBy(desc(tasks.startedAt))
      .limit(1);
    const ownerEnded = owner !== undefined && owner.status !== 'running' && owner.status !== 'queued';
    if (!ownerEnded) return restoreStillExecuting(tenantId, cart);
    const tally = await failAbandonedCart(tx, cart.id);
    refusalFound = refusalFound ?? previousRecoveryIncomplete(tenantId, cart.id, tally.done, tally.total);
  }
  return refusalFound;
}

export interface EnrollRecoveryArgs {
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly userId: string;
  /** Set when the recovery is one tenant of a batch. */
  readonly parentTaskId?: string | null;
}

function recoveryLabel(tenantId: string, tenantName: string | null): ReturnType<typeof toSafeText> {
  try {
    return toSafeText(`Recover tenant ${tenantName ?? tenantId.slice(0, 8)}`);
  } catch {
    // A name tripping the secret screen must not stop a recovery.
    return toSafeText(`Recover tenant ${tenantId.slice(0, 8)}`);
  }
}

/**
 * Enroll a `dr.recover` task for `tenantId` — or throw the 409 that says why
 * not. Reap, checks and INSERT are one transaction under the tenant's lock.
 */
export async function enrollRecoveryExclusive(db: Database, args: EnrollRecoveryArgs): Promise<string> {
  const outcome = await taskService.withTaskLock(db, `${DR_RECOVER_TASK_KIND}:${args.tenantId}`, async (tx) => {
    await taskService.failStaleActive(tx, DR_RECOVER_TASK_KIND, {
      tenantId: args.tenantId,
      staleSeconds: STALE_AFTER_SECONDS,
      error: ABANDONED_MESSAGE,
      detailsPatch: { error: ABANDONED_ERROR },
    });
    if (await taskService.hasActiveTask(tx, DR_RECOVER_TASK_KIND, { tenantId: args.tenantId })) {
      return { refused: recoveryInProgress(args.tenantId) };
    }
    // Returned, not thrown: failing an abandoned cart must COMMIT.
    const restoreRefusal = await executingRestoreRefusal(tx, args.tenantId);
    if (restoreRefusal) return { refused: restoreRefusal };

    const details: DrRecoverTaskDetails = {
      tenantId: args.tenantId,
      tenantName: args.tenantName,
      bundleId: null,
      cartId: null,
      steps: initialSteps(),
      result: null,
      error: null,
    };
    const { id } = await taskService.start(tx, {
      kind: DR_RECOVER_TASK_KIND,
      scope: 'admin',
      userId: args.userId,
      tenantId: args.tenantId,
      label: recoveryLabel(args.tenantId, args.tenantName),
      // `dr-recover` is a key in the admin panel's task modal registry (spelled
      // out so ci-task-modal-registry-check can see it).
      target: { type: 'modal', modal: 'dr-recover', modalProps: { tenantId: args.tenantId } },
      progressPct: 0,
      progressText: toSafeText('Starting'),
      details,
      parentTaskId: args.parentTaskId ?? null,
    });
    return { taskId: id };
  });
  if ('refused' in outcome) throw outcome.refused;
  return outcome.taskId;
}

/**
 * Enroll the batch's `dr.recover-all` task — or 409 while another batch runs.
 * Same pattern under the fixed batch lock.
 */
export async function enrollBatchExclusive(
  db: Database,
  startArgs: Omit<taskService.TaskStartArgs, 'kind'>,
): Promise<string> {
  const outcome = await taskService.withTaskLock(db, DR_RECOVER_ALL_TASK_KIND, async (tx) => {
    await taskService.failStaleActive(tx, DR_RECOVER_ALL_TASK_KIND, {
      staleSeconds: STALE_AFTER_SECONDS,
      error: ABANDONED_MESSAGE,
      detailsPatch: { error: { ...ABANDONED_ERROR, title: 'The batch stopped reporting progress' } },
    });
    if (await taskService.hasActiveTask(tx, DR_RECOVER_ALL_TASK_KIND, {})) {
      return {
        refused: refusal('DR_RECOVER_ALL_IN_PROGRESS', 'A batch recovery is already running.', {}, {
          title: 'A batch recovery is already running',
          detail: 'Only one Recover All runs at a time — two would recover the same tenants over each other.',
          remediation: ['Follow the running batch from the task center, and start another only once it has finished.'],
          retryable: false,
        }),
      };
    }
    const { id } = await taskService.start(tx, { ...startArgs, kind: DR_RECOVER_ALL_TASK_KIND });
    return { taskId: id };
  });
  if ('refused' in outcome) throw outcome.refused;
  return outcome.taskId;
}
