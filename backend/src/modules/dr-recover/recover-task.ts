/**
 * Tenant recovery from an off-site bundle as a task-center task.
 *
 * `POST /admin/dr/tenants/:tenantId/recover` with `background: true` lands
 * here. A recovery is minutes to hours of work — re-create, provision, a
 * restore cart that copies every file and mailbox back, the post-restore
 * reconcile — and it used to hold one HTTP request open for all of it, with
 * the outcome rendered on the page that sent it: navigate away and the result
 * was gone; outlive the proxy timeout and the browser got an error while the
 * server carried on.
 *
 * Now the request validates, enrolls a `dr.recover` task and answers. The run
 * continues server-side and reports through the task row: a step timeline,
 * the restore cart's id (its items are the per-item progress), and finally the
 * same result the synchronous call returns — or an `OperatorError`. The admin
 * panel's `dr-recover` modal renders that row, and the chip re-opens it.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  toSafeText,
  type DrRecoverRequest,
  type DrRecoverResponse,
  type DrRecoverStarted,
  type OperatorError,
} from '@insula/api-contracts';
import { restoreJobs, tenantLifecycleTransitions, tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import * as taskService from '../tasks/service.js';
import { runDrRecover } from './orchestrate.js';
import { createTaskReporter, DR_RECOVER_STEP_LABELS } from './task-reporter.js';
import { restoreFailedError, toRecoverOperatorError } from './task-error.js';
import { startHeartbeat } from './liveness.js';
import { enrollRecoveryExclusive } from './exclusive.js';
import { taskMintedAuth } from './task-credential.js';

export { DR_RECOVER_TASK_KIND } from './exclusive.js';

/**
 * The tenant's name for the task label: its row, or — deleted — the name its
 * `deleted` lifecycle transition recorded. Null when neither is known (a
 * tenant this cluster never had).
 */
export async function tenantDisplayName(app: FastifyInstance, tenantId: string): Promise<string | null> {
  const [live] = await app.db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (live) return live.name;
  const [del] = await app.db
    .select({ detail: tenantLifecycleTransitions.detail, namespace: tenantLifecycleTransitions.namespace })
    .from(tenantLifecycleTransitions)
    .where(and(eq(tenantLifecycleTransitions.tenantId, tenantId), eq(tenantLifecycleTransitions.transitionKind, 'deleted')))
    .orderBy(desc(tenantLifecycleTransitions.startedAt))
    .limit(1);
  if (!del) return null;
  const { slugFromNamespace } = await import('../tenant-bundles/recoverable.js');
  return (del.detail as { tenantName?: string } | null)?.tenantName ?? slugFromNamespace(del.namespace) ?? null;
}

export interface RunTaskArgs {
  readonly taskId: string;
  readonly tenantId: string;
  readonly input: DrRecoverRequest;
  /**
   * Who started it. Every internal call re-checks this user and carries a
   * token minted for them on the spot — the run never holds a session token.
   */
  readonly userId: string;
  /** Mirrors the step a batch member is on into the batch row. */
  readonly onStep?: (label: string) => Promise<void>;
}

export interface RecoverTaskOutcome {
  readonly result: DrRecoverResponse | null;
  readonly error: OperatorError | null;
}

async function cartLastError(app: FastifyInstance, cartId: string): Promise<string | null> {
  try {
    const [cart] = await app.db.select({ lastError: restoreJobs.lastError }).from(restoreJobs).where(eq(restoreJobs.id, cartId)).limit(1);
    return cart?.lastError ?? null;
  } catch {
    return null;
  }
}

function successText(result: DrRecoverResponse): ReturnType<typeof toSafeText> {
  const left = result.residualGaps.length;
  return toSafeText(left > 0
    ? `Recovered — ${left} manual step${left === 1 ? '' : 's'} left`
    : 'Recovered');
}

/**
 * Run one recovery against its task row to a terminal state. Never throws —
 * the outcome is in the row (and returned, for the batch).
 */
export async function runDrRecoverTask(app: FastifyInstance, args: RunTaskArgs): Promise<RecoverTaskOutcome> {
  const reporter = createTaskReporter(app, args.taskId, args.onStep);
  const stopHeartbeat = startHeartbeat(app, args.taskId);
  let result: DrRecoverResponse | null = null;
  let error: OperatorError | null = null;
  try {
    result = await runDrRecover(
      app,
      { tenantId: args.tenantId, input: args.input, auth: taskMintedAuth(app, args.userId) },
      reporter,
    );
  } catch (err) {
    const failedStep = reporter.runningStep();
    app.log.error({ err, tenantId: args.tenantId, taskId: args.taskId, step: failedStep }, 'dr-recover: background recovery failed');
    error = toRecoverOperatorError(err, failedStep ? DR_RECOVER_STEP_LABELS[failedStep] : null);
    await reporter.failRunning();
  } finally {
    stopHeartbeat();
    await reporter.dispose();
  }

  if (result && result.status !== 'done') {
    error = restoreFailedError({
      stepLabel: DR_RECOVER_STEP_LABELS.restore,
      cartId: result.cartId,
      bundleId: result.bundleId,
      lastError: await cartLastError(app, result.cartId),
    });
  }

  const { steps } = reporter.snapshot();
  try {
    await taskService.finish(app.db, args.taskId, error
      ? {
        status: 'failed',
        error: `${error.title}: ${error.detail}`.slice(0, 4096),
        text: toSafeText('Failed'),
        detailsPatch: { steps, result, error },
      }
      : {
        status: 'succeeded',
        text: successText(result!),
        detailsPatch: { steps, result, error: null },
      });
  } catch (err) {
    app.log.error({ err, taskId: args.taskId }, 'dr-recover: could not record the outcome on the task');
  }
  return { result, error };
}

export interface StartArgs {
  readonly tenantId: string;
  readonly input: DrRecoverRequest;
  /** The admin starting it — the run acts for them, re-checked at every step. */
  readonly userId: string;
}

/**
 * Validate, enroll, start in the background, answer. The checks here are the
 * ones that would otherwise produce a task doomed from its first second — an
 * unknown tenant with nothing to re-create it from, a tenant already being
 * recovered, a restore still executing (./exclusive.ts, under a DB lock).
 * Everything else fails inside the run, on the step it belongs to.
 */
export async function startDrRecoverTask(app: FastifyInstance, args: StartArgs): Promise<DrRecoverStarted> {
  const { tenantId } = args;
  const tenantName = await tenantDisplayName(app, tenantId);
  const [exists] = await app.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!exists && !args.input.bundleId) {
    const { newestRecoverableBundleId } = await import('../tenant-bundles/recoverable.js');
    if (!(await newestRecoverableBundleId(app.db, tenantId))) {
      throw new ApiError(
        'TENANT_NOT_FOUND',
        `Tenant '${tenantId}' not found; DR re-create requires an explicit bundleId to recover from`,
        404,
        { tenant_id: tenantId },
        'Pass the off-site bundleId to re-create this deleted tenant (preserving its original id).',
      );
    }
  }

  const taskId = await enrollRecoveryExclusive(app.db, { tenantId, tenantName, userId: args.userId });
  // Fire-and-forget with a mandatory catch: an unhandled rejection here takes
  // the API process down. runDrRecoverTask records its own failures. (The
  // orchestration ignores `background` — it only chose this path.)
  void runDrRecoverTask(app, { taskId, tenantId, input: args.input, userId: args.userId }).catch((err) => {
    app.log.error({ err, taskId }, 'dr-recover: background runner crashed');
  });
  return { taskId, tenantId };
}
