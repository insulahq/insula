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
  type DrRecoverTaskDetails,
  type OperatorError,
} from '@insula/api-contracts';
import { restoreJobs, tenantLifecycleTransitions, tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import * as taskService from '../tasks/service.js';
import { runDrRecover } from './orchestrate.js';
import { createTaskReporter, DR_RECOVER_STEP_LABELS, initialSteps } from './task-reporter.js';
import { restoreFailedError, toRecoverOperatorError } from './task-error.js';
import { clearAbandoned, startHeartbeat } from './liveness.js';

export const DR_RECOVER_TASK_KIND = 'dr.recover';

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

function taskLabel(tenantId: string, tenantName: string | null): ReturnType<typeof toSafeText> {
  try {
    return toSafeText(`Recover tenant ${tenantName ?? tenantId.slice(0, 8)}`);
  } catch {
    // A name tripping the secret screen must not stop a recovery.
    return toSafeText(`Recover tenant ${tenantId.slice(0, 8)}`);
  }
}

function inProgressError(tenantId: string): ApiError {
  return new ApiError(
    'DR_RECOVER_IN_PROGRESS',
    'A recovery of this tenant is already running.',
    409,
    {
      tenantId,
      operatorError: {
        code: 'DR_RECOVER_IN_PROGRESS',
        title: 'Already being recovered',
        detail: 'A recovery of this tenant is already running. Two at once would restore over each other.',
        remediation: ['Follow the running recovery from the task center, and start another only once it has finished.'],
        retryable: false,
      },
    },
  );
}

export interface EnrollArgs {
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly userId: string;
  /** Set when the recovery is one tenant of a batch. */
  readonly parentTaskId?: string | null;
}

/** Create the `dr.recover` task row — steps pending, nothing started yet. */
export async function enrollDrRecoverTask(app: FastifyInstance, args: EnrollArgs): Promise<string> {
  const details: DrRecoverTaskDetails = {
    tenantId: args.tenantId,
    tenantName: args.tenantName,
    bundleId: null,
    cartId: null,
    steps: initialSteps(),
    result: null,
    error: null,
  };
  const { id } = await taskService.start(app.db, {
    kind: DR_RECOVER_TASK_KIND,
    scope: 'admin',
    userId: args.userId,
    tenantId: args.tenantId,
    label: taskLabel(args.tenantId, args.tenantName),
    // `dr-recover` is a key in the admin panel's task modal registry (spelled
    // out so ci-task-modal-registry-check can see it).
    target: { type: 'modal', modal: 'dr-recover', modalProps: { tenantId: args.tenantId } },
    progressPct: 0,
    progressText: toSafeText('Starting'),
    details,
    parentTaskId: args.parentTaskId ?? null,
  });
  return id;
}

export interface RunTaskArgs {
  readonly taskId: string;
  readonly tenantId: string;
  readonly input: DrRecoverRequest;
  readonly authHeader: string;
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
    result = await runDrRecover(app, { tenantId: args.tenantId, input: args.input, authHeader: args.authHeader }, reporter);
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
  readonly authHeader: string;
  readonly userId: string;
}

/**
 * Validate, enroll, start in the background, answer. The checks here are the
 * ones that would otherwise produce a task doomed from its first second — an
 * unknown tenant with nothing to re-create it from, or a second recovery of a
 * tenant already being recovered. Everything else fails inside the run, on
 * the step it belongs to.
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
  await clearAbandoned(app, DR_RECOVER_TASK_KIND, tenantId);
  if (await taskService.hasActiveTask(app.db, DR_RECOVER_TASK_KIND, { tenantId })) {
    throw inProgressError(tenantId);
  }

  const taskId = await enrollDrRecoverTask(app, { tenantId, tenantName, userId: args.userId });
  // Fire-and-forget with a mandatory catch: an unhandled rejection here takes
  // the API process down. runDrRecoverTask records its own failures. (The
  // orchestration ignores `background` — it only chose this path.)
  void runDrRecoverTask(app, { taskId, tenantId, input: args.input, authHeader: args.authHeader }).catch((err) => {
    app.log.error({ err, taskId }, 'dr-recover: background runner crashed');
  });
  return { taskId, tenantId };
}
