/**
 * A `DrRecoverReporter` that turns a recovery's progress into its task-center
 * row: the step timeline in `details.steps`, a progress bar, and a one-line
 * status for the chip.
 *
 * Two things it does that the orchestration cannot:
 *  - It ADOPTS the task rows the driven routes enroll on their own — the
 *    provision route's `tenant.provision` and the restore cart's
 *    `restore.cart` — so the chip shows one recovery, not three unrelated
 *    rows (the restore cart's own row links to a page, not to this progress).
 *  - While the restore cart executes (one long synchronous call), it reads the
 *    cart's items on a timer so the chip says which item is applying.
 *
 * It never throws: a progress write that fails is logged and dropped — a
 * broken progress display must not fail a recovery.
 */

import { asc, eq } from 'drizzle-orm';
import {
  toSafeText,
  type DrRecoverStep,
  type DrRecoverStepKey,
  type DrRecoverStepState,
  type RestoreItemStatus,
  type RestoreItemType,
} from '@insula/api-contracts';
import type { FastifyInstance } from 'fastify';
import { restoreItems } from '../../db/schema.js';
import * as taskService from '../tasks/service.js';
import type { DrRecoverContext, DrRecoverReporter } from './orchestrate.js';

export const DR_RECOVER_STEP_ORDER: readonly DrRecoverStepKey[] = [
  'recreate', 'bundle', 'provision', 'queue', 'restore', 'reconcile',
];

export const DR_RECOVER_STEP_LABELS: Readonly<Record<DrRecoverStepKey, string>> = {
  recreate: 'Re-create the deleted tenant from its bundle',
  bundle: 'Check the bundle',
  provision: 'Provision the namespace and storage',
  queue: 'Queue the restore',
  restore: 'Restore the data',
  reconcile: 'Re-establish services',
};

/** Share of the bar each step covers: [start, end] in percent. */
const STEP_PCT: Readonly<Record<DrRecoverStepKey, readonly [number, number]>> = {
  recreate: [0, 10],
  bundle: [10, 15],
  provision: [15, 35],
  queue: [35, 40],
  restore: [40, 92],
  reconcile: [92, 99],
};

const ITEM_LABEL: Readonly<Record<RestoreItemType, string>> = {
  'files-paths': 'files',
  'mailboxes-by-address': 'mailboxes',
  'deployments-by-id': 'deployments',
  'databases-by-id': 'databases',
  'domains-by-id': 'domains',
  'config-tables': 'config',
};

export const RESTORE_TICK_MS = 3_000;

export function initialSteps(): DrRecoverStep[] {
  return DR_RECOVER_STEP_ORDER.map((key) => ({
    key,
    label: DR_RECOVER_STEP_LABELS[key],
    state: 'pending' as const,
    note: null,
    startedAt: null,
    finishedAt: null,
  }));
}

function safe(text: string): ReturnType<typeof toSafeText> | null {
  try {
    return toSafeText(text);
  } catch {
    return null;
  }
}

export interface TaskReporter extends DrRecoverReporter {
  /** The step a thrown error belongs to (the one still running), if any. */
  runningStep(): DrRecoverStepKey | null;
  /** Mark the running step failed — the run threw out of it. */
  failRunning(): Promise<void>;
  snapshot(): { readonly steps: DrRecoverStep[]; readonly context: DrRecoverContext };
  /** Stop timers and make a last attempt to adopt the driven routes' rows. */
  dispose(): Promise<void>;
}

/**
 * `onStep` lets a parent (the batch) mirror which step a tenant is on. It
 * must not throw either.
 */
export function createTaskReporter(
  app: FastifyInstance,
  taskId: string,
  onStep?: (label: string) => Promise<void>,
): TaskReporter {
  let steps = initialSteps();
  let context: DrRecoverContext = {};
  const pendingAdoptions = new Map<string, { kind: string; refId: string }>();
  let ticker: ReturnType<typeof setInterval> | null = null;
  let tickInFlight: Promise<void> = Promise.resolve();

  const warn = (what: string, err: unknown): void => {
    app.log.warn({ taskId, err: err instanceof Error ? err.message : String(err) }, `dr-recover task: ${what}`);
  };

  const write = async (args: taskService.TaskProgressArgs): Promise<void> => {
    try {
      await taskService.progress(app.db, taskId, args);
    } catch (err) {
      warn('progress write failed', err);
    }
  };

  const adoptPending = async (): Promise<void> => {
    for (const [key, child] of pendingAdoptions) {
      try {
        if (await taskService.adoptChildByRef(app.db, child.kind, child.refId, taskId)) pendingAdoptions.delete(key);
      } catch (err) {
        warn(`adopting ${child.kind} failed`, err);
      }
    }
  };

  const watchChild = (kind: string, refId: string): void => {
    pendingAdoptions.set(`${kind}:${refId}`, { kind, refId });
  };

  /** One read of the executing cart → "Restoring files (2 of 4)". */
  const tick = async (): Promise<void> => {
    await adoptPending();
    const cartId = context.cartId;
    if (!cartId) return;
    try {
      const items = await app.db
        .select({ type: restoreItems.type, status: restoreItems.status })
        .from(restoreItems)
        .where(eq(restoreItems.restoreJobId, cartId))
        .orderBy(asc(restoreItems.seq));
      if (items.length === 0 || ticker === null) return;
      const finished = items.filter((i) => isFinished(i.status)).length;
      const current = items.find((i) => i.status === 'applying');
      const [from, to] = STEP_PCT.restore;
      const label = current
        ? `Restoring ${ITEM_LABEL[current.type as RestoreItemType] ?? current.type} (${finished + 1} of ${items.length})`
        : `Restoring (${finished} of ${items.length} done)`;
      await write({
        pct: Math.round(from + ((to - from) * finished) / items.length),
        text: safe(label),
      });
    } catch (err) {
      warn('reading restore items failed', err);
    }
  };

  const startTicker = (): void => {
    if (ticker !== null) return;
    ticker = setInterval(() => {
      tickInFlight = tickInFlight.then(tick, tick);
    }, RESTORE_TICK_MS);
  };

  const stopTicker = async (): Promise<void> => {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
    await tickInFlight.catch(() => undefined);
  };

  const setStep = (key: DrRecoverStepKey, state: DrRecoverStepState, note: string | null | undefined): DrRecoverStep => {
    const now = new Date().toISOString();
    const updated = steps.map((s) => {
      if (s.key !== key) return s;
      const running = state === 'running';
      return {
        ...s,
        state,
        note: note === undefined ? (running ? null : s.note) : note,
        startedAt: running ? now : s.startedAt ?? (state === 'skipped' ? null : now),
        finishedAt: running ? null : state === 'skipped' ? null : now,
      };
    });
    steps = updated;
    return updated.find((s) => s.key === key)!;
  };

  const reporter: TaskReporter = {
    async step(key, state, note) {
      if (key === 'restore' && state !== 'running') await stopTicker();
      const step = setStep(key, state, note);
      const [from, to] = STEP_PCT[key];
      const pct = state === 'running' ? from : to;
      const index = DR_RECOVER_STEP_ORDER.indexOf(key) + 1;
      await write({
        pct,
        text: state === 'running' ? safe(`Step ${index} of ${DR_RECOVER_STEP_ORDER.length} — ${step.label}`) : undefined,
        detailsPatch: { steps },
      });
      if (state === 'running') {
        if (onStep) await onStep(step.label).catch((err) => warn('mirroring the step failed', err));
        if (key === 'restore') {
          // The cart enrolls its own row the moment /execute claims it.
          if (context.cartId) watchChild('restore.cart', context.cartId);
          startTicker();
        }
      }
    },

    async context(patch) {
      context = { ...context, ...patch };
      if (patch.provisioningTaskId) {
        // The provision route enrolls its row before it answers — adopt now.
        watchChild('tenant.provision', patch.provisioningTaskId);
        await adoptPending();
      }
      const detailsPatch: Record<string, unknown> = {};
      if (patch.tenantName !== undefined) detailsPatch.tenantName = patch.tenantName;
      if (patch.bundleId !== undefined) detailsPatch.bundleId = patch.bundleId;
      if (patch.cartId !== undefined) detailsPatch.cartId = patch.cartId;
      if (Object.keys(detailsPatch).length > 0) await write({ detailsPatch });
    },

    runningStep() {
      return steps.find((s) => s.state === 'running')?.key ?? null;
    },

    async failRunning() {
      const key = reporter.runningStep();
      if (key === 'restore') await stopTicker();
      if (key) setStep(key, 'failed', undefined);
    },

    snapshot() {
      return { steps, context };
    },

    async dispose() {
      await stopTicker();
      await adoptPending();
    },
  };
  return reporter;
}

function isFinished(status: RestoreItemStatus | string): boolean {
  return status === 'done' || status === 'skipped' || status === 'failed';
}
