/**
 * Step timeline for the in-place snapshot restore.
 *
 * `runRestoreFromSnapshot` is seven discrete steps, but `storage_operations`
 * only ever held the CURRENT one (as a sentence in `progress_message`), so a
 * progress modal could not say which steps had finished, how long each took,
 * or where a failed restore stopped. The orchestrator now folds every step
 * into a `StepTimeline` and persists it to `storage_operations.progress_steps`;
 * the restore-status endpoint renders it per caller (tenant-snapshots/
 * restore-status.ts).
 *
 * Everything here is pure and immutable — each transition returns a new
 * timeline — so the orchestrator's bookkeeping is unit-testable without a
 * cluster, and a persist failure can never leave a half-mutated object behind.
 */

import type { RevertStep } from './longhorn-revert.js';
import type { SnapshotRestoreStepKey } from '@insula/api-contracts';

/** The steps of a normal run, in order. `recover` is failure-only. */
export const RESTORE_STEP_ORDER: ReadonlyArray<SnapshotRestoreStepKey> = [
  'quiesce',
  'wait-detach',
  'attach-maintenance',
  'wait-maintenance',
  'revert',
  'detach-maintenance',
  'unquiesce',
];

/** Plain-language labels, shared by both panels (the API sends them). */
export const RESTORE_STEP_LABELS: Readonly<Record<SnapshotRestoreStepKey, string>> = {
  quiesce: 'Stop workloads',
  'wait-detach': 'Release the storage volume',
  'attach-maintenance': 'Attach the volume for the restore',
  'wait-maintenance': 'Wait for the volume to be ready',
  revert: 'Revert the volume to the snapshot',
  'detach-maintenance': 'Detach the volume',
  unquiesce: 'Start workloads again',
  recover: 'Start workloads again after the failure',
};

/** Progress-bar position once a step has finished. */
export const RESTORE_STEP_PCT: Readonly<Record<SnapshotRestoreStepKey, number>> = {
  quiesce: 35,
  'wait-detach': 50,
  'attach-maintenance': 58,
  'wait-maintenance': 66,
  revert: 80,
  'detach-maintenance': 88,
  unquiesce: 100,
  recover: 100,
};

export interface TimelineStep {
  readonly key: SnapshotRestoreStepKey;
  readonly ok: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Operator diagnostic (node, final volume state). Never shown to tenants. */
  readonly detail: string | null;
}

export interface StepTimeline {
  readonly steps: ReadonlyArray<TimelineStep>;
  readonly inFlight: { readonly key: SnapshotRestoreStepKey; readonly startedAt: string } | null;
}

export const EMPTY_TIMELINE: StepTimeline = { steps: [], inFlight: null };

const KNOWN_KEYS = new Set<string>(Object.keys(RESTORE_STEP_LABELS));

function isStepKey(v: unknown): v is SnapshotRestoreStepKey {
  return typeof v === 'string' && KNOWN_KEYS.has(v);
}

/** Open `key` as the in-flight step. */
export function beginStep(t: StepTimeline, key: SnapshotRestoreStepKey, now: Date): StepTimeline {
  return { steps: t.steps, inFlight: { key, startedAt: now.toISOString() } };
}

/**
 * Close `key`. Its start time is the in-flight step's when that IS `key`;
 * otherwise (a step reported without having been opened) it is `now`, so the
 * step still appears — with a zero duration — rather than being dropped.
 */
export function endStep(
  t: StepTimeline,
  key: SnapshotRestoreStepKey,
  ok: boolean,
  detail: string | null,
  now: Date,
): StepTimeline {
  const finishedAt = now.toISOString();
  const startedAt = t.inFlight?.key === key ? t.inFlight.startedAt : finishedAt;
  return {
    steps: [...t.steps, { key, ok, startedAt, finishedAt, detail }],
    inFlight: t.inFlight?.key === key ? null : t.inFlight,
  };
}

/** Record the in-flight step (if any) as failed. Idempotent: a timeline with
 *  nothing in flight comes back unchanged. */
export function failInFlight(t: StepTimeline, now: Date, detail: string | null = null): StepTimeline {
  if (!t.inFlight) return t;
  return endStep(t, t.inFlight.key, false, detail, now);
}

/** The step `revertVolumeToSnapshot` runs after each one it reports. */
const NEXT_AFTER_REVERT_STEP: Readonly<Record<string, SnapshotRestoreStepKey | null>> = {
  'wait-detach': 'attach-maintenance',
  'attach-maintenance': 'wait-maintenance',
  'wait-maintenance': 'revert',
  revert: 'detach-maintenance',
  'detach-maintenance': null,
};

/**
 * Fold one `revertVolumeToSnapshot` progress report into the timeline: close
 * the step it reports and open the step that runs next.
 *
 * `revertVolumeToSnapshot` reports a step only AFTER it finished, and on a
 * failure it reports nothing for the failing step — it detaches the volume
 * and reports THAT as `detach-maintenance` with detail `after-failure`. So an
 * `after-failure` report first closes whatever was in flight as failed; the
 * cleanup detach is then recorded on its own.
 */
export function applyRevertStep(t: StepTimeline, step: RevertStep, now: Date): StepTimeline {
  const key: SnapshotRestoreStepKey | null = step.step === 'longhorn-revert'
    ? 'revert'
    : isStepKey(step.step) ? step.step : null;
  if (!key) return t;

  if (step.detail === 'after-failure') {
    const failed = failInFlight(t, now);
    return endStep(failed, key, step.ok, 'cleanup after the failure', now);
  }

  const closed = endStep(t, key, step.ok, step.detail ?? null, now);
  const next = step.ok ? NEXT_AFTER_REVERT_STEP[key] : null;
  return next ? beginStep(closed, next, now) : closed;
}

/** True once the revert itself is recorded as succeeded. */
export function revertCompleted(t: StepTimeline): boolean {
  return t.steps.some((s) => s.key === 'revert' && s.ok);
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/**
 * Read a timeline back from the `progress_steps` jsonb. Defensive: the column
 * is untyped at the DB boundary, so anything malformed is dropped rather than
 * trusted, and a value that is not a timeline at all reads as null.
 */
export function parseTimeline(raw: unknown): StepTimeline | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { steps?: unknown; inFlight?: unknown };
  if (!Array.isArray(obj.steps)) return null;
  const steps: TimelineStep[] = [];
  for (const s of obj.steps) {
    const r = s as Partial<TimelineStep> | null;
    if (!r || !isStepKey(r.key) || typeof r.ok !== 'boolean' || !isIso(r.startedAt) || !isIso(r.finishedAt)) continue;
    steps.push({
      key: r.key,
      ok: r.ok,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      detail: typeof r.detail === 'string' ? r.detail : null,
    });
  }
  const f = obj.inFlight as { key?: unknown; startedAt?: unknown } | null | undefined;
  const inFlight = f && isStepKey(f.key) && isIso(f.startedAt) ? { key: f.key, startedAt: f.startedAt } : null;
  return { steps, inFlight };
}
