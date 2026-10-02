/**
 * The restore-status VIEW a progress modal renders: the persisted step
 * timeline turned into an ordered, per-step state list plus a structured
 * failure — shaped differently for the two kinds of caller.
 *
 *   operator  admin-panel / staff tokens. Gets everything: each step's raw
 *             `detail` (Longhorn node, final volume state) and the engine's
 *             own error text in the OperatorError diagnostics.
 *   tenant    tenant-panel tokens. Gets the same steps and timings, but no
 *             `detail` and no raw error — those name cluster internals (node
 *             names, the Longhorn manager URL, resource paths). The failure is
 *             explained in terms of the tenant's files and site instead.
 *
 * Pure: no I/O, so both audiences are unit-tested against fixed rows.
 */

import type {
  OperatorError,
  SnapshotRestoreOutcome,
  SnapshotRestoreStatus,
  SnapshotRestoreStep,
  SnapshotRestoreStepKey,
  SnapshotRestoreStepState,
} from '@insula/api-contracts';
import { operatorErrorSchema } from '@insula/api-contracts';
import {
  RESTORE_STEP_LABELS,
  RESTORE_STEP_ORDER,
  parseTimeline,
  revertCompleted,
  type StepTimeline,
  type TimelineStep,
} from '../storage-lifecycle/restore-timeline.js';

export type RestoreStatusAudience = 'tenant' | 'operator';

const STAFF_ROLES: ReadonlySet<string> = new Set(['super_admin', 'admin', 'support']);

/**
 * Which view a caller gets. Fail-closed: the operator view (step detail, raw
 * engine error) needs a staff role on a non-tenant-panel token; anything
 * else — including a token with no recognisable role — gets the tenant view.
 */
export function restoreStatusAudience(
  user: { readonly panel?: string; readonly role?: string } | null | undefined,
): RestoreStatusAudience {
  if (!user || user.panel === 'tenant') return 'tenant';
  return user.role && STAFF_ROLES.has(user.role) ? 'operator' : 'tenant';
}

/** The storage_operations columns the view reads. */
export interface RestoreOpRow {
  readonly id: string;
  readonly state: string;
  readonly progressPct: number;
  readonly progressMessage: string | null;
  readonly lastError: string | null;
  readonly params: Record<string, unknown> | null;
  readonly progressSteps: unknown;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export const SNAPSHOT_RESTORE_FAILED = 'SNAPSHOT_RESTORE_FAILED';

function outcomeOf(state: string): SnapshotRestoreOutcome {
  if (state === 'idle') return 'succeeded';
  if (state === 'failed') return 'failed';
  return 'running';
}

function elapsed(startedAt: string, finishedAt: string): number {
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

function stepView(
  key: SnapshotRestoreStepKey,
  record: TimelineStep | undefined,
  timeline: StepTimeline,
  outcome: SnapshotRestoreOutcome,
  audience: RestoreStatusAudience,
): SnapshotRestoreStep {
  const label = RESTORE_STEP_LABELS[key];
  if (record) {
    return {
      key,
      label,
      state: record.ok ? 'succeeded' : 'failed',
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      elapsedMs: elapsed(record.startedAt, record.finishedAt),
      detail: audience === 'operator' ? record.detail : null,
    };
  }
  if (timeline.inFlight?.key === key) {
    // An op that is already terminal cannot still be running a step: the
    // orchestrator died mid-step (platform-api restart) and the watchdog
    // closed the op. Show where it stopped, not a spinner that never ends.
    const state: SnapshotRestoreStepState = outcome === 'running' ? 'running' : 'failed';
    return { key, label, state, startedAt: timeline.inFlight.startedAt, finishedAt: null, elapsedMs: null, detail: null };
  }
  return {
    key,
    label,
    state: outcome === 'running' ? 'pending' : 'skipped',
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
    detail: null,
  };
}

/** Ordered steps: the normal run, then `recover` only when it happened. */
export function buildStepViews(
  timeline: StepTimeline | null,
  outcome: SnapshotRestoreOutcome,
  audience: RestoreStatusAudience,
): SnapshotRestoreStep[] {
  if (!timeline) return [];
  const lastRecord = (key: SnapshotRestoreStepKey): TimelineStep | undefined =>
    [...timeline.steps].reverse().find((s) => s.key === key);
  const views = RESTORE_STEP_ORDER.map((key) => stepView(key, lastRecord(key), timeline, outcome, audience));
  const recoverHappened = timeline.inFlight?.key === 'recover' || timeline.steps.some((s) => s.key === 'recover');
  return recoverHappened
    ? [...views, stepView('recover', lastRecord('recover'), timeline, outcome, audience)]
    : views;
}

/** `lastError` is either a raw message or a JSON OperatorError envelope
 *  (storage-lifecycle formatLifecycleError). */
function parseEnvelope(lastError: string | null): OperatorError | null {
  if (!lastError || !lastError.trimStart().startsWith('{')) return null;
  try {
    const parsed = operatorErrorSchema.safeParse(JSON.parse(lastError));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function failedStepOf(steps: ReadonlyArray<SnapshotRestoreStep>): SnapshotRestoreStep | undefined {
  return steps.find((s) => s.state === 'failed' && s.key !== 'recover');
}

/** What happened to the tenant's files, in their terms. */
function tenantFilesSentence(timeline: StepTimeline | null, failed: SnapshotRestoreStep | undefined): string {
  if (!timeline) return 'The restore did not complete.';
  if (revertCompleted(timeline)) {
    return `Your files were restored to the snapshot, but the restore failed while finishing up (“${failed?.label ?? 'final steps'}”).`;
  }
  if (failed?.key === 'revert') {
    return 'The storage system did not confirm the revert, so your files may still be in their previous state.';
  }
  return `Your files were not changed — the restore stopped at “${failed?.label ?? 'an early step'}”, before anything was reverted.`;
}

function tenantSiteSentence(steps: ReadonlyArray<SnapshotRestoreStep>): string {
  const recover = steps.find((s) => s.key === 'recover');
  if (recover?.state === 'failed') return ' Your site could not be started again automatically.';
  if (recover?.state === 'succeeded') return ' Your site was started again.';
  return '';
}

function buildError(
  op: RestoreOpRow,
  timeline: StepTimeline | null,
  steps: ReadonlyArray<SnapshotRestoreStep>,
  audience: RestoreStatusAudience,
): OperatorError {
  const failed = failedStepOf(steps);
  if (audience === 'tenant') {
    const recoverFailed = steps.some((s) => s.key === 'recover' && s.state === 'failed');
    return {
      code: SNAPSHOT_RESTORE_FAILED,
      title: 'Restore failed',
      detail: `${tenantFilesSentence(timeline, failed)}${tenantSiteSentence(steps)}`,
      remediation: recoverFailed
        ? ['Contact support and quote the operation ID below — your site needs to be started again.']
        : [
          'Try the restore again — the snapshot is still available.',
          'If it fails again, contact support and quote the operation ID below.',
        ],
      retryable: !recoverFailed,
      diagnostics: { operationId: op.id, ...(failed ? { failedStep: failed.label } : {}) },
    };
  }

  const where = { operationId: op.id, ...(failed ? { failedStep: failed.key } : {}) };
  const envelope = parseEnvelope(op.lastError);
  if (envelope) {
    return { ...envelope, diagnostics: { ...where, ...(envelope.diagnostics ?? {}) } };
  }
  return {
    code: SNAPSHOT_RESTORE_FAILED,
    title: failed ? `Snapshot restore failed at “${failed.label}”` : 'Snapshot restore failed',
    detail: op.lastError ?? 'The restore stopped without recording a reason.',
    remediation: [
      'Check the step timeline above for the step that failed and its detail.',
      'If workloads did not come back, use “Reset to idle” on the tenant\'s Storage Operations card — it also starts them again from the saved replica counts.',
      'Retry the restore once the cause is fixed — the snapshot is not consumed by a failed attempt.',
    ],
    retryable: true,
    diagnostics: { ...where, ...(op.lastError ? { raw: op.lastError } : {}) },
  };
}

/** Plain-language progress line: the running step's label, or the op's own
 *  message when no timeline exists. Never the raw step `detail` — and for a
 *  tenant, never a trailing "(…)" either: engines older than the timeline put
 *  the step detail there (`Restoring — attach-maintenance (node=…)`). */
function progressMessageFor(
  op: RestoreOpRow,
  steps: ReadonlyArray<SnapshotRestoreStep>,
  outcome: SnapshotRestoreOutcome,
  audience: RestoreStatusAudience,
): string | null {
  if (outcome === 'running') {
    const running = steps.find((s) => s.state === 'running');
    if (running) return `${running.label}…`;
  }
  const msg = op.progressMessage;
  if (!msg || audience === 'operator') return msg;
  const open = msg.lastIndexOf('(');
  return open > 0 && msg.trimEnd().endsWith(')') ? msg.slice(0, open).trimEnd() : msg;
}

export function buildRestoreStatusView(op: RestoreOpRow, audience: RestoreStatusAudience): SnapshotRestoreStatus {
  const outcome = outcomeOf(op.state);
  const timeline = parseTimeline(op.progressSteps);
  const steps = buildStepViews(timeline, outcome, audience);
  const error = outcome === 'failed' ? buildError(op, timeline, steps, audience) : null;
  const label = op.params?.label;
  return {
    operationId: op.id,
    state: op.state,
    outcome,
    progressPct: outcome === 'succeeded' ? 100 : op.progressPct,
    progressMessage: progressMessageFor(op, steps, outcome, audience),
    lastError: outcome !== 'failed' ? null : audience === 'operator' ? op.lastError : error?.detail ?? null,
    error,
    snapshotLabel: typeof label === 'string' && label.length > 0 ? label : null,
    startedAt: op.createdAt.toISOString(),
    completedAt: op.completedAt ? op.completedAt.toISOString() : null,
    steps,
  };
}
