/**
 * Batch recover-all as a task-center task.
 *
 * `POST /admin/dr/tenants/recover-all` with `background: true` lands here once
 * the target set is resolved and the encryption-key gate has passed. A batch
 * recovers tenant after tenant — sequentially, as the synchronous call does —
 * and could hold its request open for hours; now it is one `dr.recover-all`
 * task whose details list every tenant's state, and each tenant is its own
 * child `dr.recover` task (with the full step timeline), folded under the
 * batch in the chip. The admin panel's `dr-recover-all` modal renders it.
 */

import type { FastifyInstance } from 'fastify';
import {
  toSafeText,
  type DrEncryptionKeyPreflight,
  type DrRecoverAllSkipped,
  type DrRecoverAllStarted,
  type DrRecoverAllTarget,
  type DrRecoverAllTaskDetails,
  type DrRecoverAllTenantProgress,
  type DrRecoverComponent,
  type OperatorError,
} from '@insula/api-contracts';
import { ApiError } from '../../shared/errors.js';
import * as taskService from '../tasks/service.js';
import { DR_RECOVER_TASK_KIND, enrollDrRecoverTask, runDrRecoverTask } from './recover-task.js';
import { toRecoverOperatorError } from './task-error.js';
import { clearAbandoned, startHeartbeat } from './liveness.js';

export const DR_RECOVER_ALL_TASK_KIND = 'dr.recover-all';

export interface StartAllArgs {
  readonly scope: 'missing' | 'all';
  readonly targets: readonly DrRecoverAllTarget[];
  readonly skipped: readonly DrRecoverAllSkipped[];
  readonly encryptionKey: DrEncryptionKeyPreflight | null;
  /** Forwarded to every tenant's recover, as the synchronous batch does. */
  readonly perTenant: { readonly targetNode?: string; readonly components?: readonly DrRecoverComponent[] };
  readonly authHeader: string;
  readonly userId: string;
}

function initialRows(targets: readonly DrRecoverAllTarget[]): DrRecoverAllTenantProgress[] {
  return targets.map((t) => ({
    tenantId: t.tenantId,
    tenantName: t.tenantName,
    bundleId: t.bundleId,
    state: 'pending' as const,
    step: null,
    taskId: null,
    status: null,
    recreated: false,
    error: null,
  }));
}

/** The batch ran to the end, but some tenants are not back. */
function incompleteError(failed: number, total: number): OperatorError {
  return {
    code: 'DR_RECOVER_ALL_INCOMPLETE',
    title: `${failed} of ${total} tenant${total === 1 ? '' : 's'} could not be recovered`,
    detail: 'Every tenant that failed is listed with the reason; the others were recovered.',
    remediation: [
      'Fix the cause shown for each failed tenant.',
      'Then recover each of them on its own from Recover Tenant — its full step-by-step view shows where it stops.',
    ],
    retryable: false,
  };
}

function progressText(done: number, total: number, failed: number): ReturnType<typeof toSafeText> {
  return toSafeText(`${done} of ${total} tenants${failed > 0 ? ` · ${failed} failed` : ''}`);
}

export async function startDrRecoverAllTask(app: FastifyInstance, args: StartAllArgs): Promise<DrRecoverAllStarted> {
  await clearAbandoned(app, DR_RECOVER_ALL_TASK_KIND);
  if (await taskService.hasActiveTask(app.db, DR_RECOVER_ALL_TASK_KIND, {})) {
    throw new ApiError('DR_RECOVER_ALL_IN_PROGRESS', 'A batch recovery is already running.', 409, {
      operatorError: {
        code: 'DR_RECOVER_ALL_IN_PROGRESS',
        title: 'A batch recovery is already running',
        detail: 'Only one Recover All runs at a time — two would recover the same tenants over each other.',
        remediation: ['Follow the running batch from the task center, and start another only once it has finished.'],
        retryable: false,
      },
    });
  }

  const total = args.targets.length;
  const details: DrRecoverAllTaskDetails = {
    scope: args.scope,
    total,
    recovered: 0,
    failed: 0,
    tenants: initialRows(args.targets),
    skipped: [...args.skipped],
    encryptionKey: args.encryptionKey,
    error: null,
  };
  const { id: taskId } = await taskService.start(app.db, {
    kind: DR_RECOVER_ALL_TASK_KIND,
    scope: 'admin',
    userId: args.userId,
    label: toSafeText(`Recover ${total} tenant${total === 1 ? '' : 's'} from their bundles`),
    // A key in the admin panel's task modal registry (literal for ci-task-modal-registry-check).
    target: { type: 'modal', modal: 'dr-recover-all', modalProps: {} },
    progressPct: 0,
    progressText: progressText(0, total, 0),
    details,
  });

  void runBatch(app, taskId, args).catch((err) => {
    app.log.error({ err, taskId }, 'dr-recover-all: background runner crashed');
  });
  return { taskId, total };
}

async function runBatch(app: FastifyInstance, taskId: string, args: StartAllArgs): Promise<void> {
  let rows = initialRows(args.targets);
  const total = rows.length;
  const counts = (): { recovered: number; failed: number; finished: number } => ({
    recovered: rows.filter((r) => r.state === 'done').length,
    failed: rows.filter((r) => r.state === 'failed').length,
    finished: rows.filter((r) => r.state === 'done' || r.state === 'failed').length,
  });
  const update = (index: number, patch: Partial<DrRecoverAllTenantProgress>): void => {
    rows = rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
  };
  const publish = async (): Promise<void> => {
    const c = counts();
    try {
      await taskService.progress(app.db, taskId, {
        pct: total === 0 ? 100 : Math.min(99, Math.round((c.finished / total) * 100)),
        text: progressText(c.finished, total, c.failed),
        detailsPatch: { tenants: rows, recovered: c.recovered, failed: c.failed },
      });
    } catch (err) {
      app.log.warn({ taskId, err: err instanceof Error ? err.message : String(err) }, 'dr-recover-all: progress write failed');
    }
  };

  // The batch row is only written between tenants and at step changes; a
  // long restore of one tenant must not make the batch look abandoned.
  const stopHeartbeat = startHeartbeat(app, taskId);
  try {
    // SEQUENTIAL by design: a freshly-rebuilt cluster is fragile and each
    // provision+restore is heavy; parallel recovers would hammer it.
    for (let i = 0; i < rows.length; i++) {
      const target = rows[i]!;
      await clearAbandoned(app, DR_RECOVER_TASK_KIND, target.tenantId);
      if (await taskService.hasActiveTask(app.db, DR_RECOVER_TASK_KIND, { tenantId: target.tenantId })) {
        update(i, { state: 'failed', error: 'A recovery of this tenant was already running — skipped.' });
        await publish();
        continue;
      }
      const childId = await enrollDrRecoverTask(app, {
        tenantId: target.tenantId,
        tenantName: target.tenantName,
        userId: args.userId,
        parentTaskId: taskId,
      });
      update(i, { state: 'running', taskId: childId });
      await publish();

      const outcome = await runDrRecoverTask(app, {
        taskId: childId,
        tenantId: target.tenantId,
        input: {
          bundleId: target.bundleId,
          ...(args.perTenant.targetNode ? { targetNode: args.perTenant.targetNode } : {}),
          ...(args.perTenant.components ? { components: [...args.perTenant.components] } : {}),
        },
        authHeader: args.authHeader,
        onStep: async (label) => {
          update(i, { step: label });
          await publish();
        },
      });
      update(i, {
        state: outcome.error ? 'failed' : 'done',
        step: null,
        status: outcome.result?.status ?? null,
        recreated: outcome.result?.recreated ?? false,
        error: outcome.error ? outcome.error.detail : null,
      });
      await publish();
    }

    const c = counts();
    await taskService.finish(app.db, taskId, {
      status: c.failed > 0 ? 'failed' : 'succeeded',
      error: c.failed > 0 ? `${c.failed} of ${total} tenants could not be recovered` : null,
      text: toSafeText(`Recovered ${c.recovered} of ${total}`),
      detailsPatch: {
        tenants: rows,
        recovered: c.recovered,
        failed: c.failed,
        error: c.failed > 0 ? incompleteError(c.failed, total) : null,
      },
    });
  } catch (err) {
    app.log.error({ err, taskId }, 'dr-recover-all: batch stopped');
    const c = counts();
    await taskService.finish(app.db, taskId, {
      status: 'failed',
      error: 'The batch stopped before every tenant was recovered.',
      detailsPatch: {
        tenants: rows,
        recovered: c.recovered,
        failed: c.failed,
        error: toRecoverOperatorError(err, null),
      },
    }).catch(() => undefined);
  } finally {
    stopHeartbeat();
  }
}
