import crypto from 'node:crypto';
import { eq, and, sql, desc, lte, inArray, notInArray } from 'drizzle-orm';
import {
  backupJobs,
  tenants,
  storageSnapshots,
  storageOperations,
  hostingPlans,
  backupConfigurations,
} from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { type SnapshotStore } from './snapshot-store.js';
import {
  captureArchiveBundle,
  captureFilesOnlyBundle,
  restoreFilesBundleIntoPvc,
  reapPreResizeBundle,
} from './prebundle.js';
import { quiesce, unquiesce, waitForQuiesced, type QuiesceSnapshot } from './quiesce.js';
import { tenantStoragePvcLabelsFromNamespace } from '../../lib/canonical-labels.js';
import { translateOperatorError } from '../../shared/operator-error.js';
import { TENANT_LOCK_MAX_HOLD_MS, tenantLockJob, withTenantLock } from '../tenant-lifecycle/tenant-lock.js';
import { OP_MAX_RESUMES, launchOp, launchUnder, opGuard, operationIsMine } from './op-lock.js';
import { growMount, waitForGrownClaim, type GrowOutcome } from './grow-mount.js';
import {
  EMPTY_TIMELINE,
  RESTORE_STEP_LABELS,
  RESTORE_STEP_PCT,
  applyRevertStep,
  beginStep,
  endStep,
  failInFlight,
  type StepTimeline,
} from './restore-timeline.js';

/**
 * Render a raw exception message into the operator-error envelope JSON
 * (so the UI's ErrorPanel can show structured remediation), or fall
 * back to the raw string if translation produced UNKNOWN. Stored in
 * `lastError` on storage_operations / storage_snapshots.
 */
function formatLifecycleError(err: unknown, kind: 'pvc' | 'workload' | 'fm' = 'pvc'): string {
  const raw = err instanceof Error ? err.message : String(err);
  const envelope = translateOperatorError(raw, { kind });
  if (envelope.code === 'UNKNOWN') return raw;
  return JSON.stringify(envelope);
}

/**
 * Storage-lifecycle service: the high-level API for admin operations
 * (resize, suspend, resume, archive, restore, snapshot).
 *
 * Every op is a state machine that writes its progress into the
 * `storage_operations` table so the UI can poll / SSE for updates. The
 * tenant's `storage_lifecycle_state` + `active_storage_op_id` fields
 * are kept in sync so conflicting ops can be detected early.
 */

// ─── Helpers ────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

interface ServiceCtx {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly store: SnapshotStore;
  readonly platformNamespace: string;
  /**
   * Phase 3 of the snapshot-storage overhaul: when the store was
   * resolved via the per-class assignment table, this carries the
   * `backup_configurations.id` for forensic stamping on the
   * `storage_snapshots.target_id` column. Null when the legacy
   * single-active-target fallback resolved the store.
   */
  readonly targetId?: string | null;
  /**
   * Phase 3: the snapshot class this ctx was built for. Defaults to
   * 'tenant_snapshot' at the routes layer for tenant-PVC operations.
   * Stamped on `storage_snapshots.backup_class` at row creation.
   */
  readonly backupClass?: import('@insula/api-contracts').SnapshotClass;
}

/** What an operation's run needs once it has been started: the rest of the context is the starter's. */
type RunCtx = Pick<ServiceCtx, 'db' | 'k8s'>;

async function mustGetTenant(db: Database, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new ApiError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);
  return tenant;
}

/**
 * Refuse when an operation already owns the tenant. Every caller runs under
 * the tenant's lock (tenant-lock.ts), taken by the exported starter that
 * wraps it — so the state read here is still the state when the caller
 * writes its own claim a few statements on.
 */
async function mustBeIdle(db: Database, tenantId: string) {
  const [tenant] = await db.select({
    state: tenants.storageLifecycleState,
    opId: tenants.activeStorageOpId,
  }).from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new ApiError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);
  if (tenant.state !== 'idle') {
    throw new ApiError(
      'STORAGE_OP_IN_PROGRESS',
      `A ${tenant.state} operation is already in progress for this tenant`,
      409,
      { currentState: tenant.state, activeOpId: tenant.opId },
    );
  }
}

async function markTenantState(
  db: Database,
  tenantId: string,
  state: typeof tenants.$inferSelect['storageLifecycleState'],
  opId: string | null,
) {
  await db.update(tenants)
    .set({ storageLifecycleState: state, activeStorageOpId: opId })
    .where(eq(tenants.id, tenantId));
}

/** Merge the pre-quiesce replica snapshot into the op's params jsonb so a
 *  force-cancel can restore the workloads it scaled to 0. */
export async function persistQuiesceSnapshot(db: Database, opId: string, snap: QuiesceSnapshot): Promise<void> {
  const [op] = await db.select({ params: storageOperations.params }).from(storageOperations).where(eq(storageOperations.id, opId));
  const params = (op?.params as Record<string, unknown> | null) ?? {};
  await db.update(storageOperations).set({ params: { ...params, quiesceSnapshot: snap } }).where(eq(storageOperations.id, opId));
}

/** The replica snapshot persisted on an op row (pre-mutation), or null. */
async function loadPersistedQuiesceSnapshot(db: Database, opId: string): Promise<QuiesceSnapshot | null> {
  try {
    const [op] = await db.select({ params: storageOperations.params }).from(storageOperations).where(eq(storageOperations.id, opId));
    return (op?.params as { quiesceSnapshot?: QuiesceSnapshot } | null)?.quiesceSnapshot ?? null;
  } catch {
    return null;
  }
}

/**
 * Scale the tenant to zero for an operation. One that is picked up again keeps
 * the replica counts written down the first time: taken again now, with the
 * workloads already at zero, they would all be zero — and that is what the
 * tenant would be "restored" to at the end.
 */
async function quiesceForOp(
  db: Database,
  k8s: K8sClients,
  opId: string,
  namespace: string,
  resumed: boolean,
): Promise<QuiesceSnapshot> {
  const written = resumed ? await loadPersistedQuiesceSnapshot(db, opId) : null;
  if (!written) return quiesce(k8s, namespace, (snap) => persistQuiesceSnapshot(db, opId, snap));
  await quiesce(k8s, namespace);
  return written;
}

/**
 * Write keys into an operation's params, leaving the others as they are. What
 * a run notes here is what a second run reads to know how far the first got.
 */
async function noteOnOp(db: Database, opId: string, patch: Record<string, unknown>): Promise<void> {
  await db.update(storageOperations)
    .set({ params: sql`coalesce(${storageOperations.params}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(storageOperations.id, opId));
}

async function notedOnOp(db: Database, opId: string): Promise<Record<string, unknown>> {
  const [op] = await db.select({ params: storageOperations.params }).from(storageOperations).where(eq(storageOperations.id, opId));
  return op?.params ?? {};
}

/**
 * Whether an operation picked up again was cut off while its workloads were
 * being started again — its work on the volume over. Such a run must not scale
 * the tenant down and do that work a second time: the tenant has been running
 * since, and a second revert or restore would take back what it wrote.
 *
 * Read from the state the first run wrote before it started the workloads,
 * which every release has written — so it also holds for an operation that a
 * release without the pick-up began.
 */
async function cutOffWhileUnquiescing(db: Database, opId: string): Promise<boolean> {
  const [op] = await db.select({ state: storageOperations.state }).from(storageOperations).where(eq(storageOperations.id, opId));
  return op?.state === 'unquiescing';
}

/**
 * The replica counts written down for an operation — for a run that is past
 * its work on the volume and has only the workloads left to start. Without
 * them it would start nothing and still call the operation done.
 */
async function writtenQuiesceSnapshot(db: Database, opId: string): Promise<QuiesceSnapshot> {
  const snap = await loadPersistedQuiesceSnapshot(db, opId);
  if (!snap) throw new Error('The replica counts written down for this operation could not be read, so its workloads cannot be started from them.');
  return snap;
}

/**
 * Start a claimed operation under its liveness lock, before the starter
 * answers. An operation with no lock is nobody's — nothing is working on it,
 * and the watchdog reads "interrupted" from a lock that lapsed, so it would
 * never be picked up either. When the lock cannot be taken the claim is
 * withdrawn and the caller is told that nothing was started.
 */
async function beginOp(
  db: Database,
  opId: string,
  tenantId: string,
  what: string,
  run: () => Promise<void>,
): Promise<void> {
  const began = await launchOp(db, opId, run, () => noteOnOp(db, opId, { [AWAITING_LOCK]: false })).catch((err: unknown) => {
    console.error(`[storage-lifecycle] ${what} ${opId} could not take its lock:`, err);
    return false;
  });
  if (began) return;
  // When the withdrawal cannot be written either — the database that refused
  // the lock is likely the one refusing this — the claim stays, marked as
  // never begun, and the pick-up withdraws it (interrupted-ops.ts).
  await withdrawUnstartedOp(db, opId).catch((err: unknown) => {
    console.error(`[storage-lifecycle] ${what} ${opId} could not be withdrawn after its lock could not be taken:`, err);
  });
  throw new ApiError('STORAGE_OP_NOT_STARTED', `The ${what} could not be started. Nothing was changed — try again.`, 503);
}

/**
 * Written into an operation's params with its claim, and cleared under the
 * operation's lock as its run begins. While it reads true the operation has
 * never run: its starter did not get the lock, and told its caller that
 * nothing was started. Such a claim is withdrawn, never picked up — the caller
 * was not told a shrink would begin minutes later on its own.
 */
const AWAITING_LOCK = 'awaitingLock';

/**
 * Take back the claim of an operation that never began: the operation failed,
 * a snapshot row written beside it failed, the tenant as it was. False when
 * the operation has begun or ended meanwhile.
 */
export async function withdrawUnstartedOp(db: Database, opId: string): Promise<boolean> {
  const [op] = await db
    .select({ state: storageOperations.state, params: storageOperations.params, snapshotId: storageOperations.snapshotId, tenantId: storageOperations.tenantId })
    .from(storageOperations)
    .where(eq(storageOperations.id, opId));
  if (!op || op.state === 'idle' || op.state === 'failed' || op.params?.[AWAITING_LOCK] !== true) return false;
  const why = 'The operation could not be started: its lock could not be taken. Nothing was changed.';
  await updateOp(db, opId, { state: 'failed', lastError: why, completedAt: new Date() });
  if (op.snapshotId) {
    await db.update(storageSnapshots).set({ status: 'failed', lastError: why })
      .where(and(eq(storageSnapshots.id, op.snapshotId), eq(storageSnapshots.status, 'creating')));
  }
  await db.update(tenants)
    .set({ storageLifecycleState: 'idle', activeStorageOpId: null })
    .where(and(eq(tenants.id, op.tenantId), eq(tenants.activeStorageOpId, opId)));
  return true;
}

/**
 * Why a failed operation's tenant must not have its workloads started: its
 * volume does not hold its files. Null when they can be started.
 *
 * Two operations take the files off the volume the tenant mounts. A shrink
 * deletes the volume and restores the files into a smaller one: in between
 * they are in the pre-resize bundle only. A restore from a retained volume
 * deletes the claim and makes a new one on that volume: in between there is
 * no claim. Workloads started then run on an empty volume — an application
 * that finds no data sets itself up afresh, in public — and write over what a
 * later restore brings back.
 *
 * Read from the cluster, not from how far the operation says it got: a shrink
 * that failed before its delete went through still has the volume it began
 * with. A claim that cannot be read counts as not holding the files.
 */
export async function whyWorkloadsStayStopped(
  k8s: K8sClients,
  op: { readonly opType: string; readonly stoppedIn: string; readonly params: Record<string, unknown> | null; readonly namespace: string },
): Promise<string | null> {
  const shrink = op.opType === 'resize' && op.params?.mode === 'destructive'
    && (op.stoppedIn === 'replacing' || op.stoppedIn === 'restoring');
  const swap = op.opType === 'restore' && op.params?.mode === 'retained_volume' && op.stoppedIn === 'replacing';
  if (!shrink && !swap) return null;
  const claim = await readClaim(k8s, op.namespace, `${op.namespace}-storage`).catch(() => 'unreadable' as const);
  if (swap) {
    return claim !== null && claim !== 'unreadable' && !claim.deleting
      ? null
      : 'The tenant\'s workloads were left stopped: its storage was being switched to the retained volume, and it has no storage claim right now. '
        + 'Both volumes are kept. Use Reset to idle on the tenant\'s Storage Operations card, then start the restore from the retained volume again.';
  }
  const toMib = typeof op.params?.toMib === 'number' ? op.params.toMib : Number.NaN;
  const stillTheOldVolume = claim !== null && claim !== 'unreadable' && !claim.deleting && claim.requestBytes !== toMib * 1024 * 1024;
  return stillTheOldVolume
    ? null
    : 'The tenant\'s workloads were left stopped: its volume was being replaced by a smaller one and does not hold all of its files. '
      + 'They are in the pre-resize bundle, which is kept for 7 days. Restore the files from that bundle into the tenant, then use Reset to idle on the tenant\'s Storage Operations card to start the workloads.';
}

/**
 * A failure's text with the reason the workloads were left stopped, where the
 * reader will see it first: the first step of a structured error, the opening
 * of a plain one — whose own text may be a screenful of a cluster's reply.
 */
export function withHold(lastError: string, hold: string | null): string {
  if (!hold) return lastError;
  try {
    const envelope = JSON.parse(lastError) as { detail?: unknown; remediation?: unknown };
    if (envelope && typeof envelope === 'object' && typeof envelope.detail === 'string') {
      return JSON.stringify({
        ...envelope,
        remediation: [hold, ...(Array.isArray(envelope.remediation) ? envelope.remediation as unknown[] : [])],
      });
    }
  } catch { /* plain text */ }
  return `${hold}\n\nWhat failed: ${lastError}`;
}

/**
 * After an operation failed: start the tenant's workloads again and free the
 * tenant for the next operation — or, when its volume does not hold its files
 * (`hold`), leave both as they are.
 *
 * Left as it is means the tenant keeps pointing at the failed operation. That
 * pointer is what the watchdog's leftover leg and the workload-health
 * reconciler read before they "heal" workloads that sit at zero; without it
 * they would start them within minutes. **Reset to idle** — an operator's
 * decision — releases both.
 */
export async function settleTenantAfterFailure(
  db: Database,
  k8s: K8sClients,
  op: { readonly opId: string; readonly tenantId: string; readonly namespace: string },
  quiesceSnap: QuiesceSnapshot | null,
  hold: string | null,
): Promise<void> {
  const mine = and(eq(tenants.id, op.tenantId), eq(tenants.activeStorageOpId, op.opId));
  if (hold) {
    await db.update(tenants).set({ storageLifecycleState: 'failed' }).where(mine);
    return;
  }
  await unquiesceBestEffort(db, k8s, op.opId, op.namespace, quiesceSnap);
  await db.update(tenants).set({ storageLifecycleState: 'failed', activeStorageOpId: null }).where(mine);
}

/**
 * Tell the admins that a failed operation left its tenant stopped. The person
 * who started it may not be looking, and a tenant that points at an operation
 * raises no "workloads down" alert of its own. Never throws.
 */
async function tellAdminsTenantLeftStopped(db: Database, op: { readonly opId: string; readonly tenantId: string; readonly opType: string }, hold: string): Promise<void> {
  try {
    const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, op.tenantId));
    const { notifyAdminOperationalEvent } = await import('../notifications/events.js');
    await notifyAdminOperationalEvent(db, 'integrity', {
      subsystem: 'Storage operations',
      objectLabel: tenant?.name ?? op.tenantId,
      detail: `A ${op.opType} of this tenant failed.`,
      severityLabel: 'failed — tenant left stopped',
      recommendedAction: hold,
    }, `storage-op-ended:${op.opId}`);
  } catch (err) {
    console.error(`[storage-lifecycle] could not notify that op ${op.opId} left its tenant stopped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The state an operation stopped in and what it noted — read before the failure is written over it. */
async function stoppedAt(db: Database, opId: string): Promise<{ stoppedIn: string; params: Record<string, unknown> | null; tenantId: string } | null> {
  const [op] = await db
    .select({ stoppedIn: storageOperations.state, params: storageOperations.params, tenantId: storageOperations.tenantId })
    .from(storageOperations)
    .where(eq(storageOperations.id, opId));
  return op ?? null;
}

/**
 * Availability budget for the two valves that run INSIDE an HTTP request
 * (`clear-failed` and `cancel`).
 *
 * `unquiesce` now waits for the workloads to actually become available, and its
 * default budget is 5 minutes — correct for a background orchestrator, and a
 * hung request plus a proxy timeout for an operator who just clicked a button.
 * These two get a short budget instead: the valve does what it can within a
 * few seconds, reports honestly, and anything slower is owned by the
 * workload-health reconciler, which sweeps every 5 minutes and sees exactly the
 * same state (the quiesce-hold is kept on whatever did not come back).
 */
const INTERACTIVE_RESTORE_TIMEOUT_MS = 30_000;

/**
 * Failure-path unquiesce that survives `quiesce()` throwing MID-scale-down.
 *
 * Every orchestrator holds `quiesceSnap` in a local that is only assigned
 * when `quiesce()` RETURNS — a throw between "persist snapshot" and "all
 * workloads scaled" left the local null, the old `if (quiesceSnap)` guard
 * skipped the unquiesce, and the tenant stayed at 0 replicas with no
 * automatic recovery. The snapshot is
 * persisted on the op row BEFORE any mutation, so fall back to that copy.
 * Best-effort: never throws. Resolves `true` when the workloads were brought
 * back (or there was nothing to bring back), `false` when that failed — the
 * snapshot-restore timeline shows it as its `recover` step.
 */
export async function unquiesceBestEffort(
  db: Database,
  k8s: K8sClients,
  opId: string,
  namespace: string,
  localSnap: QuiesceSnapshot | null,
  opts: { availableTimeoutMs?: number } = {},
): Promise<boolean> {
  const snap = localSnap ?? await loadPersistedQuiesceSnapshot(db, opId);
  if (snap) {
    return unquiesce(k8s, namespace, snap, opts).then(() => true, (err) => {
      console.warn(`[storage-lifecycle] failure-path unquiesce for op ${opId} (${namespace}) failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    });
  }
  // No snapshot at all (crash raced the persist, so nothing was scaled
  // down) — at least clear the file-manager hold so reactive auto-start
  // works again.
  try {
    const { clearQuiesceHold } = await import('./quiesce.js');
    await clearQuiesceHold(k8s, namespace);
    return true;
  } catch (err) {
    console.warn(`[storage-lifecycle] failure-path quiesce-hold clear for op ${opId} (${namespace}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Persist a snapshot-restore step timeline to `storage_operations.progress_steps`.
 * Best-effort: the timeline is what the progress modal draws, never what the
 * restore depends on, so a failed write is logged and the restore carries on.
 */
async function persistRestoreTimeline(db: Database, opId: string, timeline: StepTimeline): Promise<void> {
  try {
    await db.update(storageOperations)
      .set({ progressSteps: timeline as unknown as Record<string, unknown> })
      .where(eq(storageOperations.id, opId));
  } catch (err) {
    console.warn(`[storage-lifecycle] restore timeline write for op ${opId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Write an op row's progress and mirror it to the Task Tracker chip. */
export async function updateOp(
  db: Database,
  opId: string,
  patch: Partial<typeof storageOperations.$inferInsert>,
) {
  await db.update(storageOperations).set(patch).where(eq(storageOperations.id, opId));
  // Mirror to the Task Tracker chip — best-effort, never throws.
  await mirrorOpToTaskTracker(db, opId).catch((err) => {
    console.warn(`[storage-lifecycle] task tracker mirror failed for ${opId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Sync a `storage_operations` row into the Task Tracker chip via the
 * tasks helper. Idempotent on `(kind='storage.<opType>', ref_id=opId)`,
 * so multiple `updateOp` calls within the same operation just refresh
 * the existing task row's progress / status.
 *
 * Cron-driven snapshot/scheduled ops have triggered_by_user_id=null —
 * we skip those (scope='system' tasks never appear in any chip per the
 * UX agreement; failures land in notifications instead).
 */
async function mirrorOpToTaskTracker(db: Database, opId: string): Promise<void> {
  const [op] = await db
    .select({
      id: storageOperations.id,
      tenantId: storageOperations.tenantId,
      opType: storageOperations.opType,
      state: storageOperations.state,
      progressPct: storageOperations.progressPct,
      progressMessage: storageOperations.progressMessage,
      lastError: storageOperations.lastError,
      triggeredByUserId: storageOperations.triggeredByUserId,
      params: storageOperations.params,
    })
    .from(storageOperations)
    .where(eq(storageOperations.id, opId))
    .limit(1);
  if (!op || !op.triggeredByUserId) return;

  // The op's `state` is the storage-lifecycle FSM (snapshotting, growing,
  // shrinking, restoring, suspending, resuming, idle, failed). Map to
  // the task's three terminal-or-running statuses.
  const isTerminal = op.state === 'idle' || op.state === 'failed';
  const taskStatus: 'running' | 'succeeded' | 'failed' =
    !isTerminal ? 'running'
    : op.state === 'failed' ? 'failed'
    : 'succeeded';

  const kind = `storage.${op.opType}`;
  const labelText = `${op.opType} storage (${op.tenantId.slice(0, 8)})`;
  // Phase 3: route to the OperationProgressModal so clicking the chip
  // re-opens the live progress view instead of just navigating to the
  // storage tab. The admin-panel registry maps `modal: 'operation'` to
  // <OperationProgressModal /> which takes `operationId` (the
  // storageOperations.id) + an optional title.
  //
  // An in-place snapshot restore records a step timeline, so its chip opens
  // the snapshot-restore modal that draws it (same view as the Snapshots tab)
  // rather than the generic single-line one.
  const isSnapshotRevert = op.opType === 'restore'
    && (op.params as { mode?: unknown } | null)?.mode === 'snapshot_revert';
  const target = isSnapshotRevert
    ? {
      type: 'modal' as const,
      modal: 'snapshot-restore',
      modalProps: { operationId: op.id, tenantId: op.tenantId },
    }
    : {
      type: 'modal' as const,
      modal: 'operation',
      modalProps: {
        operationId: op.id,
        title: `${op.opType.replace(/_/g, ' ')} — ${op.tenantId.slice(0, 8)}`,
      },
    };

  const { start: startTask, finishByRef } = await import('../tasks/service.js');
  const { toSafeText } = await import('@insula/api-contracts');

  if (taskStatus === 'running') {
    await startTask(db, {
      kind,
      refId: op.id,
      scope: 'admin',
      userId: op.triggeredByUserId,
      tenantId: op.tenantId,
      label: toSafeText(labelText),
      target,
      progressPct: op.progressPct ?? null,
      progressText: op.progressMessage ? toSafeText(op.progressMessage) : null,
      details: { opType: op.opType, state: op.state },
    });
    return;
  }

  // Terminal — also runs through start() once if the row didn't exist
  // yet (e.g. an op that completed in a single tick before any updateOp
  // call mirrored the running state).
  await startTask(db, {
    kind,
    refId: op.id,
    scope: 'admin',
    userId: op.triggeredByUserId,
    tenantId: op.tenantId,
    label: toSafeText(labelText),
    target,
    progressPct: op.progressPct ?? null,
    progressText: op.progressMessage ? toSafeText(op.progressMessage) : null,
    details: { opType: op.opType, state: op.state },
  });
  await finishByRef(db, kind, op.id, {
    status: taskStatus,
    text: op.progressMessage ? toSafeText(op.progressMessage) : null,
    error: taskStatus === 'failed' ? (op.lastError ?? 'Storage operation failed') : null,
  });
}

// ─── Resize ─────────────────────────────────────────────────────────────

export interface ResizeDryRun {
  readonly currentGi: number;
  readonly currentMib: number;
  readonly requestedGi: number;
  readonly requestedMib: number;
  readonly usedBytes: number;
  readonly willFit: boolean;
  readonly rejectReason: string | null;
  readonly estimatedSeconds: number;
}

/**
 * Estimate a resize without touching anything. Computes current used bytes
 * via `du -sb` inside the FM sidecar (already running in every tenant
 * namespace) and reports whether the new size has enough headroom.
 *
 * Safety rule: `used * 1.1 <= newGi * 1 GiB` — the new PVC must be at
 * least 10 % larger than existing data, so the tenant isn't booted back
 * onto an already-nearly-full volume, and so filesystem metadata
 * overhead doesn't eat the slack.
 */
export const RESIZE_SAFETY_FACTOR = 1.1;

/**
 * MiB-based resize dry-run. The legacy GiB entry point below wraps
 * this for backward compatibility.
 */
export async function resizeDryRunMib(
  ctx: ServiceCtx,
  tenantId: string,
  newMib: number,
): Promise<ResizeDryRun> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  // Read current size from the live PVC, not from tenants.storage_limit_override.
  // updateTenant writes the new override BEFORE dispatching to the resize
  // orchestrator, so reading the override would always return the target
  // size and short-circuit every grow as a no-op. The PVC's
  // spec.resources.requests.storage is the source of truth for what's
  // actually provisioned.
  const namespace = tenant.kubernetesNamespace;
  const pvcName = `${namespace}-storage`;
  let currentMib: number;
  try {
    const pvc = await ctx.k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace }) as { spec?: { resources?: { requests?: { storage?: string } } } };
    const sizeStr = pvc.spec?.resources?.requests?.storage;
    if (sizeStr) {
      currentMib = Math.round(parseQuantityToBytes(sizeStr) / (1024 * 1024));
    } else {
      throw new Error('PVC has no requests.storage');
    }
  } catch (err) {
    // PVC may not exist yet (provisioning still in flight) — fall back
    // to override / plan default. Logged as a warning; dryrun caller
    // should treat this as best-effort.
    console.warn(`[resizeDryRunMib] PVC read failed for ${namespace}/${pvcName}, falling back to override: ${(err as Error).message}`);
    currentMib = Math.round(await tenantStorageGi(ctx.db, tenant) * 1024);
  }
  const currentGi = Math.ceil(currentMib / 1024);

  const usedBytes = await measurePvcUsed(ctx, tenant.kubernetesNamespace);
  const newBytes = newMib * 1024 * 1024;
  const requiredBytes = Math.ceil(usedBytes * RESIZE_SAFETY_FACTOR);
  const willFit = requiredBytes <= newBytes;
  const rejectReason = willFit
    ? null
    : `Used ${(usedBytes / (1024 ** 2)).toFixed(0)} MiB × ${RESIZE_SAFETY_FACTOR} safety buffer = ${(requiredBytes / (1024 ** 2)).toFixed(0)} MiB exceeds requested ${newMib} MiB`;
  const mbPerSec = 100;
  const estimatedSeconds = Math.max(30, Math.ceil((usedBytes / (mbPerSec * 1024 * 1024)) * 2 + 15));

  return {
    currentGi,
    currentMib,
    requestedGi: Math.ceil(newMib / 1024),
    requestedMib: newMib,
    usedBytes,
    willFit,
    rejectReason,
    estimatedSeconds,
  };
}

export async function resizeDryRun(
  ctx: ServiceCtx,
  tenantId: string,
  newGi: number,
): Promise<ResizeDryRun> {
  return resizeDryRunMib(ctx, tenantId, newGi * 1024);
}

/**
 * The size the tenant's volume is provisioned at, in GiB: its own override,
 * else its plan's. Not rounded: provisioning and the namespace's storage quota
 * use this same number, so a 0.5 GiB plan has a 512Mi quota, and a claim
 * rounded up to 1Gi is refused by it.
 */
async function tenantStorageGi(
  db: Database,
  tenant: { storageLimitOverride: string | null; planId: string },
): Promise<number> {
  const own = Number(tenant.storageLimitOverride ?? 0);
  if (own > 0) return own;
  const [plan] = await db.select({ storageLimit: hostingPlans.storageLimit }).from(hostingPlans).where(eq(hostingPlans.id, tenant.planId));
  const planGi = Number(plan?.storageLimit ?? 0);
  return planGi > 0 ? planGi : 10;
}

async function measurePvcUsed(ctx: ServiceCtx, namespace: string): Promise<number> {
  // Exec `du -sb /data` in the running FM sidecar (label app=file-manager).
  // Falls back to 0 if FM isn't running (admin can still resize up; for
  // resize-down that means the safety cushion check gets bypassed — we
  // enforce that a running FM is required later in the orchestrator).
  try {
    const pods = await ctx.k8s.core.listNamespacedPod({
      namespace, labelSelector: 'app=file-manager',
    });
    const running = ((pods as { items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> }).items ?? [])
      .find((p) => p.status?.phase === 'Running');
    if (!running?.metadata?.name) return 0;

    const { Exec, KubeConfig } = await import('@kubernetes/client-node');
    const { Writable } = await import('node:stream');
    const kc = new KubeConfig();
    kc.loadFromCluster();
    const exec = new Exec(kc);
    let stdout = '';
    const out = new Writable({ write(chunk, _e, cb) { stdout += chunk.toString(); cb(); } });
    const err = new Writable({ write(_c, _e, cb) { cb(); } });
    await new Promise<void>((resolve, reject) => {
      exec.exec(namespace, running.metadata!.name!, 'file-manager',
        ['du', '-sb', '/data'],
        out, err, null, false,
        (status) => {
          const s = status as { status?: string };
          if (!s || s.status === 'Success' || s.status === undefined) resolve();
          else reject(new Error(`du exec failed: ${JSON.stringify(s)}`));
        },
      ).catch(reject);
    });
    const match = stdout.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Resize a tenant's PVC to a new size. Dispatches to:
 *
 *   • online grow (`runGrowOnline`) when newMib > currentMib — patches
 *     PVC.spec.resources.requests.storage and lets kubelet run
 *     xfs_growfs / resize2fs on the live filesystem. Zero downtime.
 *
 *   • destructive resize (`runResizeDestructive`) when newMib < currentMib —
 *     pre-resize snapshot → quiesce → delete PVC → recreate at new size →
 *     restore from snapshot → unquiesce. Used because filesystems can't
 *     shrink in place safely while the volume is mounted.
 *
 *   • no-op when newMib === currentMib (returns existing op id if any).
 *
 * Rollback for the destructive path: if anything fails AFTER the PVC
 * delete, we try to recreate the old-size PVC and restore from the
 * pre-resize snapshot (snapshot retained 7 days as rollback insurance).
 */
export async function resizeTenant(
  ctx: ServiceCtx,
  tenantId: string,
  params: { newMib?: number; newGi?: number; triggeredByUserId?: string | null },
): Promise<{ operationId: string }> {
  return withTenantLock(ctx.db, tenantId, () => startResize(ctx, tenantId, params));
}

async function startResize(
  ctx: ServiceCtx,
  tenantId: string,
  params: Parameters<typeof resizeTenant>[2],
): Promise<{ operationId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);

  if (params.newMib == null && params.newGi == null) {
    throw new ApiError('VALIDATION_ERROR', 'One of newMib or newGi is required', 400);
  }
  const newMib = params.newMib ?? (params.newGi! * 1024);

  const dry = await resizeDryRunMib(ctx, tenantId, newMib);
  if (newMib === dry.currentMib) {
    // No-op — surface a synthetic completed op so callers don't have
    // to special-case "PATCH that didn't actually change anything".
    const opId = uuid();
    await ctx.db.insert(storageOperations).values({
      id: opId,
      tenantId,
      opType: 'resize',
      state: 'idle',
      progressPct: 100,
      progressMessage: `Storage already at ${newMib} MiB — no resize needed`,
      params: { fromMib: dry.currentMib, toMib: newMib, mode: 'noop' },
      triggeredByUserId: params.triggeredByUserId ?? null,
      completedAt: new Date(),
    });
    return { operationId: opId };
  }

  if (newMib > dry.currentMib) {
    return resizeGrow(ctx, tenantId, dry.currentMib, newMib, params.triggeredByUserId ?? null);
  }
  // newMib < currentMib → destructive shrink (must check willFit).
  if (!dry.willFit) {
    throw new ApiError('RESIZE_UNSAFE', dry.rejectReason!, 400, { dryRun: dry });
  }
  // Fail FAST (before any quiesce / PVC delete): a destructive shrink captures a
  // pre-resize bundle to an off-site target BEFORE deleting the PVC. If no
  // tenant-class target is configured, the capture would only discover that
  // AFTER the tenant is already quiesced — so resolve it here, synchronously, and
  // surface NO_SNAPSHOT_TARGET to the caller without disrupting the running tenant.
  const { resolveTenantBundleTarget } = await import('./prebundle.js');
  await resolveTenantBundleTarget(ctx.db);
  return resizeDestructive(ctx, tenant.kubernetesNamespace, tenantId, dry.currentMib, newMib, params.triggeredByUserId ?? null);
}

/**
 * Online-grow path. PVC.spec.resources.requests.storage is patched up
 * to the new size; Longhorn extends the block device, then kubelet runs
 * xfs_growfs / resize2fs against the live filesystem. Pods stay up.
 *
 * State machine: snapshotting (no-op for the schema's sake) → resizing
 * (PVC patch + capacity wait) → restoring (FileSystemResizePending wait,
 * we re-use the existing state since the schema doesn't have
 * "growing_filesystem"; UI shows the textual progressMessage) → idle.
 */
async function resizeGrow(
  ctx: ServiceCtx,
  tenantId: string,
  currentMib: number,
  newMib: number,
  triggeredByUserId: string | null,
): Promise<{ operationId: string }> {
  const opId = uuid();
  const [tenant] = await ctx.db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new ApiError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);
  const namespace = tenant.kubernetesNamespace;
  const pvcName = `${namespace}-storage`;

  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId,
      tenantId,
      opType: 'resize',
      state: 'resizing',
      progressPct: 0,
      progressMessage: `Online-grow ${currentMib} → ${newMib} MiB`,
      params: { fromMib: currentMib, toMib: newMib, mode: 'grow_online', [AWAITING_LOCK]: true },
      triggeredByUserId,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'resizing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  await beginOp(ctx.db, opId, tenantId, 'resize', () => runGrowOnline(ctx, opId, namespace, pvcName, currentMib, newMib));
  return { operationId: opId };
}

async function resizeDestructive(
  ctx: ServiceCtx,
  namespace: string,
  tenantId: string,
  currentMib: number,
  newMib: number,
  triggeredByUserId: string | null,
): Promise<{ operationId: string }> {
  const opId = uuid();
  const snapId = uuid();
  const pvcName = `${namespace}-storage`;
  const preResizeRetention = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageSnapshots).values({
      id: snapId,
      tenantId,
      kind: 'pre-resize',
      status: 'creating',
      // The pre-resize snapshot is now a files-only `system` tenant
      // bundle (restic, off-site, chunked → shim-safe), not a raw tar in
      // the snapshot store. `archive_path` carries a `bundle:<id>`
      // sentinel once the bundle is captured (filled by
      // runResizeDestructive); a placeholder until then. This replaces
      // the rclone-rcat single-giant-object path that OOMed the shim.
      archivePath: 'bundle:pending',
      expiresAt: preResizeRetention,
      label: `Pre-resize ${currentMib}MiB → ${newMib}MiB`,
      backupClass: ctx.backupClass ?? 'tenant_snapshot',
      subsystem: 'tenant-pvc',
      targetId: ctx.targetId ?? null,
    });
    await tx.insert(storageOperations).values({
      id: opId,
      tenantId,
      opType: 'resize',
      state: 'snapshotting',
      progressPct: 0,
      progressMessage: 'Starting resize',
      snapshotId: snapId,
      params: { fromMib: currentMib, toMib: newMib, mode: 'destructive', [AWAITING_LOCK]: true },
      triggeredByUserId,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'snapshotting', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  await beginOp(ctx.db, opId, tenantId, 'resize', () => runResizeDestructive(ctx, opId, snapId, namespace, pvcName, newMib));
  return { operationId: opId };
}

/**
 * Orchestrate online PVC grow. Steps:
 *
 *   1. Patch PVC.spec.resources.requests.storage to the new size.
 *   2. Poll PVC.status.capacity.storage until it reflects the new size
 *      (Longhorn extends the underlying volume).
 *   3. Poll PVC.status.conditions for the absence of FileSystemResizePending
 *      (kubelet ran xfs_growfs / resize2fs against the live mount).
 *   4. Persist the new size on tenants.storageLimitOverride so the
 *      ResourceQuota and the next quota recompute see the same value.
 *
 * No quiesce, no snapshot — pods stay running throughout. Failures are
 * surfaced through the OperatorError envelope and the op is marked
 * `failed`. The PVC patch itself is best-effort idempotent.
 */
async function runGrowOnline(
  ctx: RunCtx,
  opId: string,
  namespace: string,
  pvcName: string,
  currentMib: number,
  newMib: number,
): Promise<void> {
  const newSizeStr = newMib % 1024 === 0 ? `${newMib / 1024}Gi` : `${newMib}Mi`;
  const newBytes = newMib * 1024 * 1024;
  const guard = opGuard(ctx.db, opId);
  const progress = async (state: typeof tenants.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await guard.stillMine();
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
    await ctx.db.update(tenants)
      .set({ storageLifecycleState: state })
      .where(eq(tenants.activeStorageOpId, opId));
  };

  try {
    await progress('resizing', 10, `Patching PVC ${pvcName} to ${newSizeStr}`);

    // 1. Patch PVC.spec.resources.requests.storage. Use a JSON merge
    //    patch — strategic-merge isn't supported on PVCs and a JSON
    //    patch with `op:replace` would fail if the path doesn't exist.
    try {
      const { MERGE_PATCH } = await import('../../shared/k8s-patch.js');
      await ctx.k8s.core.patchNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace,
        body: { spec: { resources: { requests: { storage: newSizeStr } } } },
      } as unknown as Parameters<typeof ctx.k8s.core.patchNamespacedPersistentVolumeClaim>[0],
        MERGE_PATCH);
    } catch (err) {
      const code = (err as { statusCode?: number; code?: number }).statusCode
        ?? (err as { code?: number }).code;
      // 422 from kubelet usually means SC doesn't allow expansion or
      // the requested size is below current — surface clearly.
      if (code === 422) {
        throw new ApiError(
          'GROW_REJECTED',
          `kubelet rejected PVC patch — storage class may not allow volume expansion, or new size ${newSizeStr} is below current`,
          400,
        );
      }
      throw err;
    }

    // 2. Poll PVC.status.capacity.storage until it reflects the new size.
    //    K8s + Longhorn flow: ControllerExpandVolume extends the block
    //    device → kubelet sets FileSystemResizePending condition →
    //    kubelet runs xfs_growfs/resize2fs on the live mount → kubelet
    //    clears the condition AND propagates the new capacity. PVC
    //    .status.capacity does not update until the whole sequence
    //    completes, so a single capacity-poll covers both the block-
    //    device extend AND the filesystem grow. Timeout 600s — enough
    //    for a slow Longhorn rebuild on a contended cluster (e.g.
    //    integration suites running back-to-back, leaving residual
    //    detach/replicate work) while still bounding indefinite hangs.
    await progress('resizing', 50, 'Extending Longhorn volume + xfs_growfs/resize2fs (kubelet)');
    // The filesystem grows on a mount. A tenant with no running pod has none,
    // so the grow starts the file manager for it (grow-mount.ts) — and where
    // that cannot be started either, the filesystem grows at the next mount.
    const mount = growMount(ctx.k8s, namespace, pvcName);
    let outcome: GrowOutcome;
    try {
      outcome = await waitForGrownClaim(ctx.k8s, namespace, pvcName, newBytes, {
        timeoutMs: 600_000,
        mount,
        onProgress: async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); },
      });
    } finally {
      await mount.release();
    }
    const whyNoMount = mount.whyNone();

    // 4. Persist the new size on the tenant row so the ResourceQuota
    //    and any subsequent quota recompute see the same value.
    await guard.stillMine();
    const tenantId = await currentTenantId(ctx.db, opId);
    if (tenantId) {
      const giDecimal = Math.round((newMib / 1024) * 100) / 100;
      await ctx.db.update(tenants).set({
        storageLimitOverride: giDecimal.toFixed(2),
      }).where(eq(tenants.id, tenantId));
    }

    await updateOp(ctx.db, opId, {
      state: 'idle',
      progressPct: 100,
      progressMessage: outcome === 'grown'
        ? `Grew ${currentMib} → ${newMib} MiB online (no downtime)`
        : `Volume extended ${currentMib} → ${newMib} MiB. No pod of the tenant mounts it now (${whyNoMount ?? 'none could be started'}), so its filesystem grows to the new size when the next one starts.`,
      completedAt: new Date(),
    });
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'idle', null);
  } catch (err) {
    if (!(await guard.failureIsMine(err))) return;
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, {
      state: 'failed', lastError: persisted, completedAt: new Date(),
    });
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'failed', null);
  }
}

/**
 * Poll PVC.status.conditions until the FileSystemResizePending
 * condition is absent (kubelet has run the FS-side grow).
 */
async function waitForFileSystemResizeCleared(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (true) {
    let pvc;
    try {
      pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
    } catch (err) {
      throw new ApiError('LONGHORN_BUSY', `Could not read PVC ${pvcName}: ${(err as Error).message}`, 502);
    }
    const conditions = ((pvc as { status?: { conditions?: Array<{ type?: string; status?: string }> } }).status?.conditions) ?? [];
    const pending = conditions.find((c) => c.type === 'FileSystemResizePending' && c.status === 'True');
    if (!pending) return;
    if (Date.now() - start > timeoutMs) {
      throw new ApiError(
        'FS_RESIZE_TIMEOUT',
        `kubelet has not cleared FileSystemResizePending on PVC ${pvcName} within ${timeoutMs}ms. xfs_growfs / resize2fs may have failed; check kubelet logs on the node currently mounting this PVC.`,
        504,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Parse a Kubernetes resource quantity (e.g. "10Gi", "5120Mi", "10000000000")
 * into bytes. Supports binary (Ki/Mi/Gi/Ti) and SI (K/M/G/T) suffixes.
 */
function parseQuantityToBytes(qty: string): number {
  const m = qty.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  const unit = m[2];
  const binary: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5 };
  const decimal: Record<string, number> = { K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5, k: 1000 };
  if (!unit) return value;
  if (binary[unit]) return value * binary[unit];
  if (decimal[unit]) return value * decimal[unit];
  return value;
}

async function runResizeDestructive(
  ctx: RunCtx,
  opId: string,
  snapId: string,
  namespace: string,
  pvcName: string,
  newMib: number,
  resumed = false,
): Promise<void> {
  let quiesceSnap: QuiesceSnapshot | null = null;
  let preResizeBundleId: string | null = null;
  const guard = opGuard(ctx.db, opId);

  const progress = async (state: typeof tenants.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await guard.stillMine();
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
    await ctx.db.update(tenants)
      .set({ storageLifecycleState: state })
      .where(eq(tenants.activeStorageOpId, opId));
  };

  try {
    const noted = resumed ? await notedOnOp(ctx.db, opId) : {};
    const tenantIdForBundle = (await currentTenantId(ctx.db, opId))!;
    preResizeBundleId = resumed ? await bundleOnSnapshot(ctx.db, snapId) : null;

    if (resumed && await cutOffWhileUnquiescing(ctx.db, opId)) {
      // Picked up after the data was back on the new volume: only the
      // workloads and the bookkeeping are left.
      quiesceSnap = await writtenQuiesceSnapshot(ctx.db, opId);
    } else {
      await progress('quiescing', 5, 'Scaling workloads to zero');
      // quiesce persists the pre-quiesce replica counts on the op BEFORE scaling
      // anything down, so a force-cancel mid-flight can restore them instead of
      // leaving the tenant scaled to 0 (DOWN).
      quiesceSnap = await quiesceForOp(ctx.db, ctx.k8s, opId, namespace, resumed);
      await waitForQuiesced(ctx.k8s, namespace);

      const newBytes = newMib * 1024 * 1024;
      const newSizeStr = newMib % 1024 === 0
        ? `${newMib / 1024}Gi`
        : `${newMib}Mi`;
      // Only a run picked up again can find the smaller volume already there.
      let live = await readClaim(ctx.k8s, namespace, pvcName);
      const replaced = resumed && live !== null && !live.deleting && live.requestBytes === newBytes;

      if (!preResizeBundleId) {
        // The files exist in one place only until they are captured: on the
        // old volume. A run that finds no capture and no old volume has
        // nothing to resize, and must not "capture" the empty new one.
        if (resumed && (live === null || replaced)) {
          throw new ApiError(
            'SNAPSHOT_INCOMPLETE',
            `The pre-resize files bundle was not captured and volume ${pvcName} is no longer the one it would be taken from — refusing to continue.`,
            500,
          );
        }
        await progress('snapshotting', 15, 'Capturing pre-resize files bundle (off-site, restic)');
        if (resumed) {
          // The capture the dead process was in the middle of: nobody is
          // waiting for it, and its Job would hold the volume against the delete.
          const [op] = await ctx.db.select({ createdAt: storageOperations.createdAt }).from(storageOperations).where(eq(storageOperations.id, opId));
          const { settleInterruptedCaptures } = await import('./prebundle.js');
          await settleInterruptedCaptures(ctx.db, ctx.k8s, tenantIdForBundle, op?.createdAt ?? new Date(0));
        }
        // Pre-resize snapshot = files-only `system` tenant bundle. The
        // tenant-ns Job tars the PVC and streams it to platform-api's
        // `restic backup --stdin`, which chunks into 64 MiB packs — no single
        // large object ever hits the shim's gofakes3 (the OOM bug). Off-site,
        // restic, standard bundle lifecycle.
        const bundle = await captureFilesOnlyBundle({
          db: ctx.db,
          k8s: ctx.k8s,
          tenantId: tenantIdForBundle,
          label: `Pre-resize ${pvcName} → ${newMib}MiB`,
        });
        // A `partial` bundle means the files component did not fully capture
        // — refuse to delete the PVC without a complete rollback source.
        if (bundle.status !== 'completed') {
          throw new ApiError(
            'SNAPSHOT_INCOMPLETE',
            `Pre-resize files bundle ${bundle.bundleId} finished '${bundle.status}', not 'completed' — refusing to delete the PVC without a complete rollback snapshot.`,
            500,
          );
        }
        await guard.stillMine();
        preResizeBundleId = bundle.bundleId;
        await ctx.db.update(storageSnapshots).set({
          status: 'ready',
          archivePath: `bundle:${bundle.bundleId}`,
          sizeBytes: String(bundle.sizeBytes),
          sha256: null,
        }).where(eq(storageSnapshots.id, snapId));
        live = await readClaim(ctx.k8s, namespace, pvcName);
      }

      await progress('replacing', 40, `Recreating PVC at ${newSizeStr}`);
      if (!replaced) {
        // Preserve the tenant's storage class across the recreate. The PVC was
        // provisioned with selectTenantStorageClass() (`longhorn-tenant`, which
        // ships replicas=1 for LOCAL); recreating with the platform DEFAULT class
        // (`longhorn`, replicas=3) silently re-tiered a LOCAL tenant to 3 replicas.
        // It is read from the live PVC BEFORE that is deleted, and noted on the
        // operation: a run picked up after the delete has no PVC to read it from.
        const { selectTenantStorageClass } = await import('../k8s-provisioner/service.js');
        const storageClass = (typeof noted.storageClass === 'string' && noted.storageClass)
          || live?.storageClass
          || selectTenantStorageClass(namespace);
        await noteOnOp(ctx.db, opId, { storageClass });
        await guard.stillMine();
        // Delete old PVC (swallow 404 — the PVC may already be gone, e.g.
        // if a previous failed op's rollback dropped it).
        try {
          await ctx.k8s.core.deleteNamespacedPersistentVolumeClaim({ name: pvcName, namespace } as Parameters<typeof ctx.k8s.core.deleteNamespacedPersistentVolumeClaim>[0]);
        } catch (err) {
          if (!is404(err)) throw err;
        }
        // Poll until gone
        await waitForPvcGone(ctx.k8s, namespace, pvcName);
        await guard.stillMine();
        // Recreate at MiB granularity so sub-GiB resizes (e.g. 2500 MiB)
        // survive — applyPVCMib picks the right k8s suffix (Mi vs Gi).
        await applyPVCMib(ctx.k8s, namespace, newMib, storageClass);
      }

      await progress('restoring', 60, 'Restoring data from pre-resize bundle');
      // Restore the files bundle into the freshly recreated (smaller) PVC.
      // A tenant-ns Job runs `restic restore` (restic-native) against the
      // per-tenant shim repo and overlays it onto the PVC — the file-level
      // repack a block snapshot can't do when shrinking.
      await restoreFilesBundleIntoPvc({
        db: ctx.db,
        k8s: ctx.k8s,
        bundleId: preResizeBundleId,
        tenantId: tenantIdForBundle,
        namespace,
        pvcName,
        resumed,
        onProgress: async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); },
      });
    }

    await progress('unquiescing', 90, 'Scaling workloads back up');
    if (quiesceSnap) await unquiesce(ctx.k8s, namespace, quiesceSnap);

    // Persist the new size on the tenant row (override) + refresh quota
    await guard.stillMine();
    const tenantId = await currentTenantId(ctx.db, opId);
    if (tenantId) {
      // storage_limit_override is numeric(8,2) GiB; keep one-decimal
      // precision so 2500 MiB shows as 2.44 GiB. Round to 2 dp.
      const giDecimal = Math.round((newMib / 1024) * 100) / 100;
      await ctx.db.update(tenants).set({
        storageLimitOverride: giDecimal.toFixed(2),
      }).where(eq(tenants.id, tenantId));
    }

    // Resize confirmed — reap the pre-resize bundle. The off-site
    // rollback source is no longer needed now that the new PVC is live
    // and restored. Best-effort; never throws (the bundle's 7-day expiry
    // is the backstop if this fails). Mark the snapshot row reaped so the
    // UI/housekeeping don't treat a deleted bundle as restorable.
    if (preResizeBundleId) {
      await reapPreResizeBundle({ db: ctx.db, k8s: ctx.k8s, bundleId: preResizeBundleId });
      await ctx.db.update(storageSnapshots)
        .set({ status: 'expired', expiresAt: new Date() })
        .where(eq(storageSnapshots.id, snapId));
    }

    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100, progressMessage: 'Resize complete', completedAt: new Date(),
    });
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'idle', null);
  } catch (err) {
    if (!(await guard.failureIsMine(err))) return;
    const was = await stoppedAt(ctx.db, opId);
    // A shrink that fails once the old volume is gone has the files in the
    // bundle only: its workloads are not started on the empty volume.
    const hold = was ? await whyWorkloadsStayStopped(ctx.k8s, { opType: 'resize', namespace, ...was }) : null;
    const persisted = withHold(formatLifecycleError(err, 'pvc'), hold);
    await updateOp(ctx.db, opId, {
      state: 'failed', lastError: persisted, completedAt: new Date(),
    });
    // Settle the pre-resize snapshot row so it doesn't dangle in
    // 'creating'/'bundle:pending' forever. If the bundle DID capture
    // before the failure, point the row at it (it's retained as a
    // 7-day rollback source — NOT reaped on failure); otherwise mark
    // failed. Best-effort; the op is already marked failed.
    await ctx.db.update(storageSnapshots)
      .set(preResizeBundleId
        ? { status: 'ready', archivePath: `bundle:${preResizeBundleId}` }
        : { status: 'failed', lastError: persisted })
      .where(eq(storageSnapshots.id, snapId))
      .catch(() => {});
    // Best-effort unquiesce so the old workloads come back up — falls
    // back to the op-persisted snapshot when quiesce() threw mid-flight.
    if (was) await settleTenantAfterFailure(ctx.db, ctx.k8s, { opId, tenantId: was.tenantId, namespace }, quiesceSnap, hold);
    if (was && hold) await tellAdminsTenantLeftStopped(ctx.db, { opId, tenantId: was.tenantId, opType: 'resize' }, hold);
  }
}

/** The tenant's claim as it stands: what it asks for, its class, and whether it is on its way out. Null when absent. */
async function readClaim(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
): Promise<{ readonly requestBytes: number; readonly storageClass: string | null; readonly deleting: boolean } | null> {
  try {
    const pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace } as Parameters<typeof k8s.core.readNamespacedPersistentVolumeClaim>[0]) as {
      metadata?: { deletionTimestamp?: unknown };
      spec?: { storageClassName?: string; resources?: { requests?: { storage?: string } } };
    } | undefined;
    const request = pvc?.spec?.resources?.requests?.storage;
    return {
      requestBytes: request ? parseQuantityToBytes(request) : Number.NaN,
      storageClass: pvc?.spec?.storageClassName ?? null,
      deleting: pvc?.metadata?.deletionTimestamp != null,
    };
  } catch (err) {
    if (is404(err)) return null;
    throw err;
  }
}

/** When an operation began — what its first run's own transition is found by. */
async function startOf(db: Database, opId: string): Promise<Date> {
  const [op] = await db.select({ createdAt: storageOperations.createdAt }).from(storageOperations).where(eq(storageOperations.id, opId));
  return op?.createdAt ?? new Date();
}

async function currentTenantId(db: Database, opId: string): Promise<string | null> {
  const [op] = await db.select({ tenantId: storageOperations.tenantId }).from(storageOperations).where(eq(storageOperations.id, opId));
  return op?.tenantId ?? null;
}

function is404(err: unknown): boolean {
  // @kubernetes/client-node v1+ surfaces HTTP status in multiple shapes
  // depending on the call site — HttpError.code, statusCode, or the
  // parsed Status body's .code. Normalize here so callers don't care.
  const e = err as { code?: number | string; statusCode?: number; body?: { code?: number } };
  if (e.statusCode === 404) return true;
  if (e.code === 404) return true;
  if (e.body?.code === 404) return true;
  const msg = (err instanceof Error ? err.message : String(err)) || '';
  return msg.includes('HTTP-Code: 404') || msg.includes('"code":404');
}

/**
 * Create the tenant PVC at a MiB-granular size. Uses k8s's "Mi" or
 * "Gi" suffix depending on whether the requested size is a whole-GiB
 * multiple. Swallow 409 (already exists).
 */
async function applyPVCMib(k8s: K8sClients, namespace: string, sizeMib: number, storageClass: string): Promise<void> {
  const sizeStr = sizeMib % 1024 === 0 ? `${sizeMib / 1024}Gi` : `${sizeMib}Mi`;
  try {
    // backup-coverage: captured-by:files
    // (recreate the canonical `${namespace}-storage` PVC during
    // resize/replace flows; same PVC the files component captures.)
    await k8s.core.createNamespacedPersistentVolumeClaim({
      namespace,
      body: {
        metadata: {
          name: `${namespace}-storage`,
          namespace,
          labels: {
            // Same label set as applyPVC in k8s-provisioner — the
            // destructive-resize path replaces the PVC, so without
            // re-stamping these labels the tenant would drop out of the
            // daily filesystem trim and the canonical label index after a
            // shrink/snap-restore.
            //
            // `default` grants trim only. It is not a backup group, and it no
            // longer grants hourly snapshots either — those are scoped to
            // `system-critical` (the platform database).
            'recurring-job-group.longhorn.io/default': 'enabled',
            'app.kubernetes.io/part-of': 'hosting-platform',
            'app.kubernetes.io/component': 'tenant-storage',
            ...tenantStoragePvcLabelsFromNamespace(namespace),
          },
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: storageClass,
          resources: { requests: { storage: sizeStr } },
        },
      },
    });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number; code?: number }).statusCode ?? (err as { code?: number }).code;
    if (status !== 409) throw err;
  }
}

async function waitForPvcGone(k8s: K8sClients, namespace: string, pvcName: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
    } catch (err) {
      if (is404(err)) return;
      throw err;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`PVC ${pvcName} still exists after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ─── Restore from a tenant VolumeSnapshot (on-server) ───────────────────────

/**
 * Restore the tenant PVC to one of its on-server snapshots by reverting the
 * EXISTING Longhorn volume in place (NOT a destructive PVC swap). Flow:
 * resolve the CSI VolumeSnapshot → underlying Longhorn volume+snapshot →
 * quiesce (scale every workload to 0) → maintenance-attach + `snapshotRevert`
 * via longhorn-manager → unquiesce. The PVC and its volume are never deleted;
 * replicas stay healthy. The snapshot is preserved (revert doesn't consume it).
 *
 * This replaces the earlier `spec.dataSource` clone, which copied the data but
 * left the new volume stuck `copy-completed-awaiting-healthy` while detached.
 *
 * Because revert is in-place, the volume size is unchanged — there's no
 * resize and no size validation. A snapshot can only be reverted onto the
 * SAME volume it was taken from; if the tenant's PVC was recreated since (e.g.
 * a destructive shrink), the bound volume differs and we refuse with
 * SNAPSHOT_VOLUME_MISMATCH (the snapshot lived inside the now-deleted volume).
 *
 * Tracked in storage_operations (opType='restore') so the panel can poll. Like
 * the destructive resize, the orchestration runs in-process — a platform-api
 * rollout mid-op abandons it at its current state (the op stays non-idle; the
 * `clear-failed` valve recovers it).
 */
export async function restoreTenantFromVolumeSnapshot(
  db: Database,
  k8s: K8sClients,
  args: {
    readonly tenantId: string;
    readonly volumeSnapshotName: string;
    readonly snapshotLabel?: string | null;
    readonly triggeredByUserId?: string | null;
  },
): Promise<{ operationId: string }> {
  return withTenantLock(db, args.tenantId, () => startRestoreFromVolumeSnapshot(db, k8s, args));
}

async function startRestoreFromVolumeSnapshot(
  db: Database,
  k8s: K8sClients,
  args: Parameters<typeof restoreTenantFromVolumeSnapshot>[2],
): Promise<{ operationId: string }> {
  const tenant = await mustGetTenant(db, args.tenantId);
  await mustBeIdle(db, args.tenantId);
  const namespace = tenant.kubernetesNamespace;
  if (!namespace) throw new ApiError('CONFIG_INVALID', `Tenant ${args.tenantId} has no kubernetes namespace`, 400);
  const pvcName = `${namespace}-storage`;

  const {
    resolveLonghornSnapshotFromCsi, assertSnapshotRevertable, RevertError,
  } = await import('./longhorn-revert.js');

  // Resolve the CSI VolumeSnapshot to its Longhorn volume + snapshot, and
  // assert it's actually revertable, BEFORE we touch the running tenant.
  let volumeName: string;
  let snapshotName: string;
  try {
    ({ volumeName, snapshotName } = await resolveLonghornSnapshotFromCsi(k8s, namespace, args.volumeSnapshotName));
  } catch (err) {
    if (err instanceof RevertError) throw new ApiError('SNAPSHOT_NOT_RESTORABLE', err.message, err.code);
    throw err;
  }

  // The snapshot must belong to the volume the PVC is CURRENTLY bound to.
  // A missing/unbound PVC is ALSO a mismatch: in-place revert reverts the
  // bound volume, so if there's no bound volume (PVC gone/unbound, or we
  // can't read it) there's nothing safe to revert — refuse rather than
  // revert a volume the tenant's workloads can't remount.
  const boundVolume = await readPvcBoundVolume(k8s, namespace, pvcName);
  if (boundVolume !== volumeName) {
    throw new ApiError(
      'SNAPSHOT_VOLUME_MISMATCH',
      boundVolume === null
        ? 'Your current storage volume couldn\'t be found, so this snapshot can\'t be restored in place. '
          + 'It may have been recreated since the snapshot was taken (e.g. by a storage shrink).'
        : 'This snapshot was taken from a previous version of your storage volume that no longer exists '
          + '(your volume was recreated since — e.g. by a storage shrink), so it can\'t be restored in place.',
      409,
    );
  }

  try {
    await assertSnapshotRevertable(k8s, volumeName, snapshotName);
  } catch (err) {
    if (err instanceof RevertError) throw new ApiError('SNAPSHOT_NOT_RESTORABLE', err.message, err.code);
    throw err;
  }

  const opId = uuid();
  await db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId,
      tenantId: args.tenantId,
      opType: 'restore',
      state: 'quiescing',
      progressPct: 0,
      progressMessage: 'Starting restore from snapshot',
      params: { mode: 'snapshot_revert', volumeSnapshotName: args.volumeSnapshotName, volumeName, snapshotName, label: args.snapshotLabel ?? null, [AWAITING_LOCK]: true },
      triggeredByUserId: args.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(eq(tenants.id, args.tenantId));
  });

  await beginOp(db, opId, args.tenantId, 'restore', () => runRestoreFromSnapshot(db, k8s, opId, namespace, volumeName, snapshotName));
  return { operationId: opId };
}

async function runRestoreFromSnapshot(
  db: Database,
  k8s: K8sClients,
  opId: string,
  namespace: string,
  volumeName: string,
  snapshotName: string,
  resumed = false,
): Promise<void> {
  let quiesceSnap: QuiesceSnapshot | null = null;
  const guard = opGuard(db, opId);
  const progress = async (state: typeof tenants.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await guard.stillMine();
    await updateOp(db, opId, { state, progressPct: pct, progressMessage: msg });
    await db.update(tenants).set({ storageLifecycleState: state }).where(eq(tenants.activeStorageOpId, opId));
  };
  // Every step lands in `progress_steps` so both panels can draw the timeline
  // (restore-timeline.ts). Each transition yields a NEW timeline; this is the
  // one binding that tracks the latest.
  let timeline: StepTimeline = EMPTY_TIMELINE;
  const track = async (next: StepTimeline): Promise<void> => {
    timeline = next;
    await persistRestoreTimeline(db, opId, next);
  };

  try {
    // Picked up after the volume was reverted: the tenant has been running on
    // it since, and a second revert would take back what it wrote meanwhile.
    if (resumed && await cutOffWhileUnquiescing(db, opId)) {
      quiesceSnap = await writtenQuiesceSnapshot(db, opId);
    } else {
      await progress('quiescing', 5, 'Scaling workloads to zero');
      await track(beginStep(timeline, 'quiesce', new Date()));
      // quiesce persists the snapshot before scaling (force-cancel safety).
      quiesceSnap = await quiesceForOp(db, k8s, opId, namespace, resumed);
      await waitForQuiesced(k8s, namespace);
      await track(endStep(timeline, 'quiesce', true, null, new Date()));

      await progress('restoring', 40, 'Reverting your volume to the snapshot');
      await track(beginStep(timeline, 'wait-detach', new Date()));
      const { revertVolumeToSnapshot, releaseLeftoverMaintenanceAttach } = await import('./longhorn-revert.js');
      // The process that died may have left the volume attached for its own revert.
      if (resumed) await releaseLeftoverMaintenanceAttach(k8s, volumeName);
      await guard.stillMine();
      await revertVolumeToSnapshot(k8s, volumeName, snapshotName, {
        onStep: async (step) => {
          await track(applyRevertStep(timeline, step, new Date()));
          // The cleanup detach after a failure is reported as a successful
          // step; writing its label here would read like progress for the
          // moment until the failure path below takes over the message.
          if (step.detail === 'after-failure') return;
          // The message names the step now RUNNING, in the same words as the
          // timeline. The step's raw `detail` (node name, volume state) stays
          // in the timeline, which the tenant view strips — it never reaches
          // this message, which tenants and the task chip both read.
          const finished = timeline.steps[timeline.steps.length - 1]?.key;
          const current = timeline.inFlight?.key ?? finished;
          if (!finished || !current) return;
          await updateOp(db, opId, {
            progressPct: RESTORE_STEP_PCT[finished],
            progressMessage: `Restoring — ${RESTORE_STEP_LABELS[current]}`,
          });
        },
      });
    }

    await progress('unquiescing', 90, 'Scaling workloads back up');
    await track(beginStep(timeline, 'unquiesce', new Date()));
    if (quiesceSnap) await unquiesce(k8s, namespace, quiesceSnap);
    await track(endStep(timeline, 'unquiesce', true, null, new Date()));

    await updateOp(db, opId, { state: 'idle', progressPct: 100, progressMessage: 'Restore complete', completedAt: new Date() });
    const cId = await currentTenantId(db, opId);
    if (cId) await markTenantState(db, cId, 'idle', null);
  } catch (err) {
    if (!(await guard.failureIsMine(err))) return;
    const persisted = formatLifecycleError(err, 'pvc');
    // Record where it stopped, then bring the workloads back BEFORE the op
    // turns terminal: a progress modal stops polling at `failed`, so the
    // recovery has to be visible (as the `recover` step) while it runs.
    await track(failInFlight(timeline, new Date()));
    await updateOp(db, opId, { progressMessage: 'Restore failed — starting workloads again' }).catch((e: unknown) => {
      console.warn(`[storage-lifecycle] restore op ${opId}: progress write before recovery failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    await track(beginStep(timeline, 'recover', new Date()));
    // Best-effort unquiesce so the old workloads come back up. The volume
    // was never deleted; on failure the tenant remounts it in whatever state
    // the revert reached (either fully reverted, or unchanged if we failed
    // before the snapshotRevert call landed). Falls back to the
    // op-persisted snapshot when quiesce() threw mid-flight.
    const recovered = await unquiesceBestEffort(db, k8s, opId, namespace, quiesceSnap);
    await track(endStep(timeline, 'recover', recovered, null, new Date()));
    await updateOp(db, opId, { state: 'failed', progressMessage: 'Restore failed', lastError: persisted, completedAt: new Date() });
    const cId = await currentTenantId(db, opId);
    if (cId) await markTenantState(db, cId, 'failed', null);
  }
}

/** The Longhorn volume (PV) name the PVC is currently bound to, or null if the
 *  PVC is gone / unbound / unreadable. */
async function readPvcBoundVolume(k8s: K8sClients, namespace: string, pvcName: string): Promise<string | null> {
  try {
    const pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
    return (pvc as { spec?: { volumeName?: string } }).spec?.volumeName ?? null;
  } catch (err) {
    if (!is404(err)) {
      console.warn(`[storage-lifecycle] readPvcBoundVolume(${namespace}/${pvcName}) failed: ${(err as Error).message}`);
    }
    return null;
  }
}

// ─── Restore from a RETAINED volume (post-shrink rollback) ──────────────

/**
 * Restore the tenant PVC from a **retained** (Released, detached) Longhorn
 * volume — the old volume left behind when a destructive shrink recreated
 * the PVC (the `longhorn-tenant` StorageClass is `reclaimPolicy: Retain`,
 * so the old volume + its snapshots survive). This is the cross-volume case
 * that {@link restoreTenantFromVolumeSnapshot} deliberately refuses
 * (`SNAPSHOT_VOLUME_MISMATCH`): here it's intentional.
 *
 * Decisions (docs/roadmap/RETAINED_VOLUME_RESTORE.md):
 *   - Q1: the volume currently bound is RETAINED as a fallback (its PV goes
 *     Released, Retain SC) — never deleted on cutover; the orphan reaper
 *     reclaims it after its window.
 *   - Q2: restore to the admin-chosen snapshot on the retained volume.
 *
 * Flow: resolve+guard (tenancy via {@link listRetainedVolumesForTenant}) →
 * pre-flight revert → quiesce → revert the retained volume to the snapshot →
 * rebind the PVC onto it (delete current PVC = new fallback, static-bind a
 * new PVC to the retained PV) → unquiesce. Tracked in storage_operations
 * (opType='restore', params.mode='retained_volume').
 */
export async function restoreTenantFromRetainedVolume(
  db: Database,
  k8s: K8sClients,
  args: {
    readonly tenantId: string;
    readonly pvName: string;
    readonly snapshotName: string;
    readonly triggeredByUserId?: string | null;
  },
): Promise<{ operationId: string }> {
  return withTenantLock(db, args.tenantId, () => startRestoreFromRetainedVolume(db, k8s, args));
}

async function startRestoreFromRetainedVolume(
  db: Database,
  k8s: K8sClients,
  args: Parameters<typeof restoreTenantFromRetainedVolume>[2],
): Promise<{ operationId: string }> {
  const tenant = await mustGetTenant(db, args.tenantId);
  await mustBeIdle(db, args.tenantId);
  const namespace = tenant.kubernetesNamespace;
  if (!namespace) throw new ApiError('CONFIG_INVALID', `Tenant ${args.tenantId} has no kubernetes namespace`, 400);
  const pvcName = `${namespace}-storage`;

  // Resolve + GUARD. listRetainedVolumesForTenant only ever returns
  // Released PVs claim-reffed to THIS tenant's namespace, so finding the
  // chosen pv+snapshot here both resolves the Longhorn volume name and
  // enforces tenancy — an admin can't address an arbitrary cluster volume.
  const { listRetainedVolumesForTenant } = await import('./retained-volumes.js');
  const retained = await listRetainedVolumesForTenant(db, k8s, args.tenantId);
  const chosen = retained.find((r) => r.pvName === args.pvName);
  if (!chosen) {
    throw new ApiError('RETAINED_VOLUME_NOT_FOUND', `No retained volume '${args.pvName}' is available for this tenant`, 404);
  }
  const snap = chosen.snapshots.find((s) => s.name === args.snapshotName);
  if (!snap) {
    throw new ApiError('RETAINED_SNAPSHOT_NOT_FOUND', `Snapshot '${args.snapshotName}' was not found on retained volume '${args.pvName}'`, 404);
  }
  const retainedVolume = chosen.longhornVolumeName;

  // Never restore onto the currently-bound volume — that's the in-place
  // revert path (restoreTenantFromVolumeSnapshot), not a retained restore.
  const boundVolume = await readPvcBoundVolume(k8s, namespace, pvcName);
  if (boundVolume && boundVolume === retainedVolume) {
    throw new ApiError(
      'RETAINED_VOLUME_IS_BOUND',
      'That volume is the one currently in use — restore it in place from its snapshot instead of as a retained volume.',
      409,
    );
  }

  // Pre-flight the revert BEFORE touching the running tenant.
  const { assertSnapshotRevertable, RevertError } = await import('./longhorn-revert.js');
  try {
    await assertSnapshotRevertable(k8s, retainedVolume, args.snapshotName);
  } catch (err) {
    if (err instanceof RevertError) throw new ApiError('SNAPSHOT_NOT_RESTORABLE', err.message, err.code);
    throw err;
  }

  const opId = uuid();
  await db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId,
      tenantId: args.tenantId,
      opType: 'restore',
      state: 'quiescing',
      progressPct: 0,
      progressMessage: 'Starting restore from retained volume',
      params: {
        mode: 'retained_volume',
        retainedPvName: args.pvName,
        retainedVolumeName: retainedVolume,
        snapshotName: args.snapshotName,
        sizeBytes: chosen.sizeBytes,
        [AWAITING_LOCK]: true,
      },
      triggeredByUserId: args.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(eq(tenants.id, args.tenantId));
  });

  await beginOp(db, opId, args.tenantId, 'restore', () => runRestoreFromRetained(db, k8s, opId, namespace, pvcName, {
    retainedPvName: args.pvName,
    retainedVolumeName: retainedVolume,
    snapshotName: args.snapshotName,
  }));
  return { operationId: opId };
}

async function runRestoreFromRetained(
  db: Database,
  k8s: K8sClients,
  opId: string,
  namespace: string,
  pvcName: string,
  plan: { readonly retainedPvName: string; readonly retainedVolumeName: string; readonly snapshotName: string },
  resumed = false,
): Promise<void> {
  let quiesceSnap: QuiesceSnapshot | null = null;
  const guard = opGuard(db, opId);
  const progress = async (state: typeof tenants.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await guard.stillMine();
    await updateOp(db, opId, { state, progressPct: pct, progressMessage: msg });
    await db.update(tenants).set({ storageLifecycleState: state }).where(eq(tenants.activeStorageOpId, opId));
  };

  try {
    const noted = resumed ? await notedOnOp(db, opId) : {};
    if (resumed && await cutOffWhileUnquiescing(db, opId)) {
      // Picked up after the swap: the tenant may be running on the retained
      // volume already. Only the workloads and the bookkeeping are left.
      quiesceSnap = await writtenQuiesceSnapshot(db, opId);
    } else {
      await progress('quiescing', 5, 'Scaling workloads to zero');
      // quiesce persists the snapshot before scaling (force-cancel safety).
      quiesceSnap = await quiesceForOp(db, k8s, opId, namespace, resumed);
      await waitForQuiesced(k8s, namespace);

      // A run picked up again may find the claim on the retained volume
      // already. Reverting that volume a second time would be harmless;
      // swapping a second time would set the retained volume itself aside as
      // "the fallback".
      const bound = await readPvcBoundVolume(k8s, namespace, pvcName);
      let restoredCapacity: string;
      if (resumed && bound === plan.retainedPvName) {
        await waitForPvcBound(k8s, namespace, pvcName);
        restoredCapacity = await readPvCapacity(k8s, plan.retainedPvName);
      } else {
        // 1. Revert the retained (detached) volume to the chosen snapshot. It's
        //    a different volume from the one the PVC is bound to, so this is
        //    safe to do before the swap.
        await progress('restoring', 30, 'Reverting the retained volume to the chosen snapshot');
        const { revertVolumeToSnapshot, releaseLeftoverMaintenanceAttach } = await import('./longhorn-revert.js');
        // The process that died may have left the volume attached for its own revert.
        if (resumed) await releaseLeftoverMaintenanceAttach(k8s, plan.retainedVolumeName);
        await guard.stillMine();
        await revertVolumeToSnapshot(k8s, plan.retainedVolumeName, plan.snapshotName, {
          onStep: async (step) => {
            await updateOp(db, opId, { progressMessage: `Reverting — ${step.step}${step.detail ? ` (${step.detail})` : ''}` });
          },
        });

        // 2. The volume the PVC is currently bound to becomes the fallback (Q1).
        //    Noted on the op BEFORE the swap — so the orphan surface and an
        //    operator can see exactly what was set aside, and so a run picked
        //    up in mid-swap, with the claim already gone, still knows it.
        if (!('fallbackVolume' in noted)) await noteOnOp(db, opId, { fallbackVolume: bound });

        // 3. Swap the PVC onto the retained volume. Deleting the current PVC
        //    leaves its volume Released (Retain SC) = the fallback.
        await progress('replacing', 60, 'Switching your storage to the retained volume');
        restoredCapacity = await rebindPvcToRetainedVolume(k8s, namespace, pvcName, plan.retainedPvName);
      }

      // Persist the restored size (the retained volume may be larger than the
      // current — e.g. a rollback of a shrink) so the quota reconciler keeps the
      // raised `<ns>-storage-quota` instead of reconciling it back down to the
      // shrunk override and fighting the now-larger PVC.
      await guard.stillMine();
      // Rounded up to the override's two decimals, never to a whole GiB: a
      // 512Mi volume stays 0.50, not a 1 GiB quota around a 512Mi claim.
      const restoredGi = Math.max(0.01, Math.ceil(parseQuantityToBytes(restoredCapacity) / (1024 ** 3) * 100) / 100);
      const tIdForSize = await currentTenantId(db, opId);
      if (tIdForSize) {
        await db.update(tenants).set({ storageLimitOverride: restoredGi.toFixed(2) }).where(eq(tenants.id, tIdForSize));
      }
    }

    await progress('unquiescing', 90, 'Scaling workloads back up');
    if (quiesceSnap) await unquiesce(k8s, namespace, quiesceSnap);

    await guard.stillMine();
    await updateOp(db, opId, {
      state: 'idle', progressPct: 100,
      progressMessage: 'Restore complete — your previous volume is retained as a fallback',
      completedAt: new Date(),
    });
    const cId = await currentTenantId(db, opId);
    if (cId) await markTenantState(db, cId, 'idle', null);
  } catch (err) {
    if (!(await guard.failureIsMine(err))) return;
    const was = await stoppedAt(db, opId);
    const hold = was ? await whyWorkloadsStayStopped(k8s, { opType: 'restore', namespace, ...was }) : null;
    const persisted = withHold(formatLifecycleError(err, 'pvc'), hold);
    await updateOp(db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    // Best-effort unquiesce. The current PVC is only deleted once the
    // retained volume is reverted + Available, so a failure before the swap
    // leaves the original volume bound and remountable; a failure after the
    // swap leaves the (reverted) retained volume bound. One in the middle of
    // it leaves no claim at all, and then the workloads are not started.
    // Falls back to the op-persisted snapshot when quiesce() threw mid-flight.
    if (was) await settleTenantAfterFailure(db, k8s, { opId, tenantId: was.tenantId, namespace }, quiesceSnap, hold);
    if (was && hold) await tellAdminsTenantLeftStopped(db, { opId, tenantId: was.tenantId, opType: 'restore' }, hold);
  }
}

async function readPvCapacity(k8s: K8sClients, pvName: string): Promise<string> {
  const pv = await (k8s.core as unknown as {
    readPersistentVolume: (a: { name: string }) => Promise<{ spec?: { capacity?: { storage?: string } } }>;
  }).readPersistentVolume({ name: pvName });
  const capacity = pv.spec?.capacity?.storage;
  if (!capacity) throw new ApiError('RETAINED_PV_INVALID', `Retained PV ${pvName} has no capacity`, 500);
  return capacity;
}

/**
 * Swap the tenant's `<ns>-storage` PVC onto a retained (Released) PV.
 *   1. Delete the current PVC. Its PV (longhorn-tenant, Retain) survives as
 *      a Released fallback volume.
 *   2. Wait for the PVC object to disappear.
 *   3. Clear the retained PV's stale `claimRef` (RFC-7396 merge → null) so it
 *      returns to `Available`.
 *   4. Create a new PVC of the SAME name with `spec.volumeName` set so
 *      Kubernetes statically binds it to that exact PV — no dynamic provision,
 *      no clone.
 *   5. Wait for the new PVC to bind.
 */
async function rebindPvcToRetainedVolume(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
  retainedPvName: string,
): Promise<string> {
  const pv = await (k8s.core as unknown as {
    readPersistentVolume: (a: { name: string }) => Promise<{ spec?: { capacity?: { storage?: string }; storageClassName?: string } }>;
  }).readPersistentVolume({ name: retainedPvName });
  const capacity = pv.spec?.capacity?.storage;
  const storageClass = pv.spec?.storageClassName ?? 'longhorn-tenant';
  if (!capacity) throw new ApiError('RETAINED_PV_INVALID', `Retained PV ${retainedPvName} has no capacity`, 500);

  // 1 + 2. Delete the current PVC, wait until it's gone.
  try {
    await k8s.core.deleteNamespacedPersistentVolumeClaim({ name: pvcName, namespace } as Parameters<typeof k8s.core.deleteNamespacedPersistentVolumeClaim>[0]);
  } catch (err) {
    if (!is404(err)) throw err;
  }
  await waitForPvcGone(k8s, namespace, pvcName);

  // 3. Clear the stale claimRef so the retained PV becomes Available.
  const { MERGE_PATCH } = await import('../../shared/k8s-patch.js');
  await k8s.core.patchPersistentVolume(
    { name: retainedPvName, body: { spec: { claimRef: null } } } as unknown as Parameters<typeof k8s.core.patchPersistentVolume>[0],
    MERGE_PATCH,
  );
  await waitForPvPhase(k8s, retainedPvName, new Set(['Available', 'Bound']));

  // 3b. Raise the namespace storage quota to fit the retained volume. A prior
  // shrink lowered `<ns>-storage-quota` requests.storage to the shrunk size, so
  // statically binding back to the larger (pre-shrink) retained volume would be
  // 403-rejected by the ResourceQuota. The current PVC was just deleted above
  // (used=0), so this raise never drops the quota below what's in use.
  try {
    await k8s.core.patchNamespacedResourceQuota(
      { name: `${namespace}-storage-quota`, namespace, body: { spec: { hard: { 'requests.storage': capacity } } } } as unknown as Parameters<typeof k8s.core.patchNamespacedResourceQuota>[0],
      MERGE_PATCH,
    );
  } catch (err) {
    if (!is404(err)) throw err; // some namespaces may not have a storage quota
  }

  // 4. Create a new PVC statically bound to the retained PV.
  // backup-coverage: captured-by:files
  // (re-bind of the SAME tenant-storage volume onto its retained PV — no new data
  //  dimension; the tenant files are captured by the files component, as at the
  //  primary tenant-storage create-site.)
  await k8s.core.createNamespacedPersistentVolumeClaim({
    namespace,
    body: {
      metadata: {
        name: pvcName,
        namespace,
        labels: {
          'recurring-job-group.longhorn.io/default': 'enabled',
          'app.kubernetes.io/part-of': 'hosting-platform',
          'app.kubernetes.io/component': 'tenant-storage',
          ...tenantStoragePvcLabelsFromNamespace(namespace),
        },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: storageClass,
        volumeName: retainedPvName,
        resources: { requests: { storage: capacity } },
      },
    },
  } as Parameters<typeof k8s.core.createNamespacedPersistentVolumeClaim>[0]);

  // 5. Wait for the bind to complete.
  await waitForPvcBound(k8s, namespace, pvcName);
  return capacity;
}

/** Poll a PV until its phase is in `phases`, or time out. */
async function waitForPvPhase(k8s: K8sClients, pvName: string, phases: ReadonlySet<string>, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      const pv = await (k8s.core as unknown as {
        readPersistentVolume: (a: { name: string }) => Promise<{ status?: { phase?: string } }>;
      }).readPersistentVolume({ name: pvName });
      if (pv.status?.phase && phases.has(pv.status.phase)) return;
    } catch (err) {
      if (!is404(err)) throw err;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`PV ${pvName} did not reach ${[...phases].join('/')} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Poll a PVC until it is `Bound`, or time out. */
async function waitForPvcBound(k8s: K8sClients, namespace: string, pvcName: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      const pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace }) as { status?: { phase?: string } };
      if (pvc.status?.phase === 'Bound') return;
    } catch (err) {
      if (!is404(err)) throw err;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`PVC ${pvcName} did not bind within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ─── Operator recovery ─────────────────────────────────────────────────

/**
 * Force a tenant's storage state back to `idle` after a failed op has
 * left it stuck in `failed`. Admin-only; returns the previous state so
 * the audit log can record what was cleared.
 *
 * This is a safety valve, NOT a retry — the failed operation's DB row
 * is kept (with its error) so operators can diagnose what went wrong
 * before attempting the op again.
 */
export async function clearFailedStorageState(
  db: Database,
  tenantId: string,
  // Optional so the route can pass the cluster clients; without them the
  // clear still works but cannot restore scaled-down workloads.
  k8s?: K8sClients,
): Promise<{ previousState: string }> {
  const [c] = await db
    .select({ state: tenants.storageLifecycleState, namespace: tenants.kubernetesNamespace })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!c) throw new ApiError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);
  if (c.state !== 'failed') {
    throw new ApiError(
      'NOT_IN_FAILED_STATE',
      `Tenant is in state '${c.state}', not 'failed' — only failed ops can be force-cleared`,
      409,
      { currentState: c.state },
    );
  }
  // Restore any workloads the failed op left at 0 replicas. The failed
  // op cleared tenants.active_storage_op_id, so resolve the tenant's
  // most recent failed op row and unquiesce from its persisted replica
  // snapshot. Without this the "clear failed state" valve reset the DB
  // flag while the tenant's site stayed DOWN (operator report #7).
  if (k8s && c.namespace) {
    const [lastFailedOp] = await db
      .select({ id: storageOperations.id })
      .from(storageOperations)
      .where(and(
        eq(storageOperations.tenantId, tenantId),
        eq(storageOperations.state, 'failed'),
      ))
      .orderBy(desc(storageOperations.createdAt))
      .limit(1);
    if (lastFailedOp) {
      await unquiesceBestEffort(db, k8s, lastFailedOp.id, c.namespace, null, {
        availableTimeoutMs: INTERACTIVE_RESTORE_TIMEOUT_MS,
      });
    } else {
      const { clearQuiesceHold } = await import('./quiesce.js');
      await clearQuiesceHold(k8s, c.namespace);
    }
  }
  await db
    .update(tenants)
    .set({ storageLifecycleState: 'idle', activeStorageOpId: null })
    .where(eq(tenants.id, tenantId));
  return { previousState: c.state };
}

/**
 * Force-cancel an in-progress storage operation. Works on ANY non-idle
 * state. Best-effort deletes the underlying Job(s) and resets the
 * tenant's storage state to idle so subsequent ops can proceed.
 * Idempotent — calling on state=idle returns deletedJobs=0.
 */
export async function cancelStorageOperation(
  ctx: ServiceCtx,
  tenantId: string,
): Promise<{ previousState: string; deletedJobs: number; cancelledOpId: string | null }> {
  const [c] = await ctx.db
    .select({
      state: tenants.storageLifecycleState,
      activeOpId: tenants.activeStorageOpId,
      namespace: tenants.kubernetesNamespace,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!c) throw new ApiError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);
  if (c.state === 'idle') {
    return { previousState: 'idle', deletedJobs: 0, cancelledOpId: null };
  }

  // The operation is ended FIRST. A run that is still alive asks before every
  // step whether the operation is its own (op-lock.ts); marked failed, it
  // stops — it must not go on to delete a volume under the workloads this
  // cancel is about to start. One that had already ended keeps what it said.
  if (c.activeOpId) {
    await ctx.db
      .update(storageOperations)
      .set({
        state: 'failed',
        completedAt: new Date(),
        lastError: `Cancelled by operator (was state='${c.state}')`,
      })
      .where(and(eq(storageOperations.id, c.activeOpId), sql`${storageOperations.state} NOT IN ('idle', 'failed')`));
  }

  // Best-effort delete K8s Jobs in both namespaces because Tier-1
  // (fsck) lives in platform-tenant-ops while Tier-2 (snapshot /
  // restore) lives in the tenant namespace.
  const labelSelector = `platform.io/tenant-id=${tenantId}`;
  let deletedJobs = 0;
  for (const ns of ['platform-tenant-ops', c.namespace ?? '']) {
    if (!ns) continue;
    try {
      const list = await (ctx.k8s.batch as unknown as {
        listNamespacedJob: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }>;
      }).listNamespacedJob({ namespace: ns, labelSelector });
      for (const job of list.items ?? []) {
        const name = job.metadata?.name;
        if (!name) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await (ctx.k8s.batch as unknown as {
            deleteNamespacedJob: (a: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
          }).deleteNamespacedJob({ name, namespace: ns, propagationPolicy: 'Background' });
          deletedJobs++;
        } catch { /* tolerate already-gone */ }
      }
    } catch { /* tolerate listing failures (RBAC, ns-missing) */ }
  }

  // Restore any workloads the cancelled op had quiesced (scaled to 0) — a
  // destructive resize/fsck scales the tenant to 0 before its Job runs, so
  // cancelling mid-flight would otherwise leave the tenant DOWN. The
  // pre-quiesce replica counts were persisted on the op's params.
  if (c.activeOpId && c.namespace) {
    const [op] = await ctx.db.select({ params: storageOperations.params }).from(storageOperations).where(eq(storageOperations.id, c.activeOpId));
    const snap = (op?.params as { quiesceSnapshot?: QuiesceSnapshot } | null)?.quiesceSnapshot;
    if (snap) {
      await unquiesce(ctx.k8s, c.namespace, snap, {
        availableTimeoutMs: INTERACTIVE_RESTORE_TIMEOUT_MS,
      }).catch((err) => {
        console.warn(`[storage-lifecycle] cancel unquiesce failed for ${tenantId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
  // Belt-and-suspenders: clear the file-manager quiesce-hold even when there
  // was no persisted snapshot to unquiesce (cancel raced the snapshot persist),
  // so the file-manager can auto-start again after a cancel.
  if (c.namespace) {
    const { clearQuiesceHold } = await import('./quiesce.js');
    await clearQuiesceHold(ctx.k8s, c.namespace);
  }

  await ctx.db
    .update(tenants)
    .set({ storageLifecycleState: 'idle', activeStorageOpId: null })
    .where(eq(tenants.id, tenantId));

  return { previousState: c.state, deletedJobs, cancelledOpId: c.activeOpId };
}

// ─── Suspend / Resume ──────────────────────────────────────────────────

export async function suspendTenant(
  ctx: ServiceCtx,
  tenantId: string,
  /**
   * `suppressTenantNotification` carries the operator's "Notify tenant"
   * choice down to the lifecycle hook that honours it. It has to be threaded
   * explicitly: the hook reads it off the cascade context, and until
   * nothing on this path set it, so the checkbox did nothing.
   */
  opts: { triggeredByUserId?: string | null; suppressTenantNotification?: boolean } = {},
): Promise<{ operationId: string }> {
  return withTenantLock(ctx.db, tenantId, () => suspendTenantLocked(ctx, tenantId, opts));
}

/** The operator's choices for a suspend or a resume, as its operation keeps them. */
interface TransitionOpts {
  readonly triggeredByUserId?: string | null;
  readonly suppressTenantNotification?: boolean;
}

/**
 * Kept on the operation because a suspend or a resume picked up again after
 * its process died is finished by another process, which was not asked
 * whether the tenant should be told.
 */
const paramsOf = (opts: TransitionOpts): Record<string, unknown> => (
  opts.suppressTenantNotification === true ? { suppressTenantNotification: true } : {}
);

async function suspendTenantLocked(
  ctx: ServiceCtx,
  tenantId: string,
  opts: TransitionOpts,
): Promise<{ operationId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);
  if (tenant.status === 'suspended') {
    throw new ApiError('ALREADY_SUSPENDED', 'Tenant is already suspended', 409);
  }

  const opId = uuid();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId, tenantId, opType: 'suspend',
      state: 'quiescing', progressPct: 0, progressMessage: 'Scaling workloads to zero',
      params: paramsOf(opts),
      triggeredByUserId: opts.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  try {
    await runSuspend(ctx, { opId, tenantId, namespace: tenant.kubernetesNamespace }, opts, false);
    return { operationId: opId };
  } catch (err) {
    await failTransitionOp(ctx.db, opId, tenantId, err);
    throw new ApiError('SUSPEND_FAILED', err instanceof Error ? err.message : String(err), 502);
  }
}

interface TransitionOp {
  readonly opId: string;
  readonly tenantId: string;
  readonly namespace: string;
}

/**
 * The suspend itself. Written so that it can be run again from the top after
 * the process that ran it died (`resumed`): the replica counts written down
 * the first time are kept, and the cascades are finished where they stopped
 * instead of being run a second time.
 */
async function runSuspend(ctx: RunCtx, op: TransitionOp, opts: TransitionOpts, resumed: boolean): Promise<void> {
  // Persist the snapshot before scaling so a cancel during the cascades
  // below can still un-quiesce (resume also reads it from the completed op).
  await quiesceForOp(ctx.db, ctx.k8s, op.opId, op.namespace, resumed);

  // Cross-cutting cascades (ingress swap, mailbox disable, domains
  // status, webcron off). Runs AFTER quiesce so pods are already
  // gone by the time we pull the ingress rug.
  const cascades = await import('../tenant-lifecycle/cascades.js');
  const cascadeCtx = {
    db: ctx.db,
    k8s: ctx.k8s,
    triggeredByUserId: opts.triggeredByUserId ?? null,
    suppressTenantNotification: opts.suppressTenantNotification === true,
  };
  if (resumed) await cascades.applyOnceSince(cascadeCtx, op.tenantId, op.namespace, 'suspended', await startOf(ctx.db, op.opId));
  else await cascades.applySuspended(cascadeCtx, op.tenantId, op.namespace);

  // The replica counts a resume reads are on the operation already: the
  // quiesce wrote them down before it scaled anything.
  await updateOp(ctx.db, op.opId, {
    state: 'idle', progressPct: 100,
    progressMessage: 'Tenant suspended',
    completedAt: new Date(),
  });
  // applySuspended dispatched the suspended-transition hooks
  // (tenants-status-stamp wrote status='suspended'); here we just
  // clear the storage-lifecycle state since that's not hook-owned.
  await ctx.db.update(tenants).set({
    storageLifecycleState: 'idle',
    activeStorageOpId: null,
  }).where(and(eq(tenants.id, op.tenantId), eq(tenants.activeStorageOpId, op.opId)));
}

/** A suspend or a resume that failed: the operation failed, the tenant free for the next one. */
async function failTransitionOp(db: Database, opId: string, tenantId: string, err: unknown): Promise<void> {
  const persisted = formatLifecycleError(err, 'workload');
  await updateOp(db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
  await db.update(tenants)
    .set({ storageLifecycleState: 'idle', activeStorageOpId: null })
    .where(and(eq(tenants.id, tenantId), eq(tenants.activeStorageOpId, opId)));
}

export async function resumeTenant(
  ctx: ServiceCtx,
  tenantId: string,
  /**
   * `suppressTenantNotification` carries the operator's "Notify tenant"
   * choice down to the lifecycle hook that honours it. It has to be threaded
   * explicitly: the hook reads it off the cascade context, and until
   * nothing on this path set it, so the checkbox did nothing.
   */
  opts: { triggeredByUserId?: string | null; suppressTenantNotification?: boolean } = {},
): Promise<{ operationId: string }> {
  return withTenantLock(ctx.db, tenantId, () => resumeTenantLocked(ctx, tenantId, opts));
}

async function resumeTenantLocked(
  ctx: ServiceCtx,
  tenantId: string,
  opts: TransitionOpts,
): Promise<{ operationId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);
  if (tenant.status !== 'suspended') {
    throw new ApiError('NOT_SUSPENDED', 'Tenant is not suspended', 409);
  }

  const opId = uuid();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId, tenantId, opType: 'resume',
      state: 'unquiescing', progressPct: 0, progressMessage: 'Scaling workloads back up',
      params: paramsOf(opts),
      triggeredByUserId: opts.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'unquiescing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  try {
    await runResume(ctx, { opId, tenantId, namespace: tenant.kubernetesNamespace }, opts, false);
    return { operationId: opId };
  } catch (err) {
    await failTransitionOp(ctx.db, opId, tenantId, err);
    throw new ApiError('RESUME_FAILED', err instanceof Error ? err.message : String(err), 502);
  }
}

/**
 * The resume itself, and — like the suspend — safe to run again from the top:
 * scaling the workloads to the counts their suspend wrote down is the same
 * the second time, and the cascades are finished where they stopped.
 */
async function runResume(ctx: RunCtx, op: TransitionOp, opts: TransitionOpts, resumed: boolean): Promise<void> {
  // Look up the last suspend op for the quiesce snapshot it recorded.
  const [suspendOp] = await ctx.db.select().from(storageOperations).where(
    and(eq(storageOperations.tenantId, op.tenantId), eq(storageOperations.opType, 'suspend')),
  ).orderBy(desc(storageOperations.createdAt)).limit(1);
  const quiesceSnap = (suspendOp?.params as { quiesceSnapshot?: QuiesceSnapshot } | null)?.quiesceSnapshot;
  if (quiesceSnap) {
    await unquiesce(ctx.k8s, op.namespace, quiesceSnap);
  }

  // Reverse the suspend cascades — restore ingress backends, re-enable
  // mail, webcron, domains.
  const cascades = await import('../tenant-lifecycle/cascades.js');
  const cascadeCtx = {
    db: ctx.db,
    k8s: ctx.k8s,
    triggeredByUserId: opts.triggeredByUserId ?? null,
    suppressTenantNotification: opts.suppressTenantNotification === true,
  };
  if (resumed) await cascades.applyOnceSince(cascadeCtx, op.tenantId, op.namespace, 'active', await startOf(ctx.db, op.opId));
  else await cascades.applyActive(cascadeCtx, op.tenantId, op.namespace);

  await updateOp(ctx.db, op.opId, {
    state: 'idle', progressPct: 100, progressMessage: 'Tenant resumed', completedAt: new Date(),
  });
  // applyActive dispatched the active-transition hooks
  // (tenants-status-stamp wrote status='active' + cleared
  // suspendedAt/archivedAt); clear the storage-lifecycle state.
  await ctx.db.update(tenants).set({
    storageLifecycleState: 'idle',
    activeStorageOpId: null,
  }).where(and(eq(tenants.id, op.tenantId), eq(tenants.activeStorageOpId, op.opId)));
}

/**
 * Pick up a suspend or a resume whose process is gone, and finish it. They run
 * under the tenant's lock, not an operation's, so that is the lock taken here
 * — a suspend that is running after all holds it, and is left to itself.
 *
 * Finished, not ended: one cut off among its cascades has stamped the tenant
 * suspended and not yet taken its site down, or the other way round, and
 * "suspend it again" is refused for a tenant that already reads suspended.
 */
export async function resumeTransitionOp(ctx: RunCtx, opId: string): Promise<ResumeOutcome> {
  const [op] = await ctx.db
    .select({
      opType: storageOperations.opType,
      state: storageOperations.state,
      params: storageOperations.params,
      tenantId: storageOperations.tenantId,
      triggeredByUserId: storageOperations.triggeredByUserId,
      namespace: tenants.kubernetesNamespace,
      activeOpId: tenants.activeStorageOpId,
    })
    .from(storageOperations)
    .innerJoin(tenants, eq(tenants.id, storageOperations.tenantId))
    .where(eq(storageOperations.id, opId));
  if (!op || op.state === 'idle' || op.state === 'failed' || op.activeOpId !== opId) return 'ended';
  if (op.opType !== 'suspend' && op.opType !== 'resume') return 'unknown';
  const params = op.params ?? {};
  const resumes = Number(params.resumes ?? 0);
  if (!Number.isFinite(resumes) || resumes >= OP_MAX_RESUMES) return 'spent';
  const target: TransitionOp = { opId, tenantId: op.tenantId, namespace: op.namespace };
  const opts: TransitionOpts = {
    triggeredByUserId: op.triggeredByUserId,
    suppressTenantNotification: params.suppressTenantNotification === true,
  };
  const began = await launchUnder(ctx.db, tenantLockJob(op.tenantId), TENANT_LOCK_MAX_HOLD_MS, async () => {
    // The run that was only slow may have finished between the look above and
    // the lock, or the operator may have cleared the tenant.
    const [still] = await ctx.db.select({ id: storageOperations.id })
      .from(storageOperations)
      .innerJoin(tenants, and(eq(tenants.id, storageOperations.tenantId), eq(tenants.activeStorageOpId, storageOperations.id)))
      .where(and(eq(storageOperations.id, opId), notInArray(storageOperations.state, ['idle', 'failed'])));
    if (!still) return;
    await noteOnOp(ctx.db, opId, { resumes: resumes + 1 });
    await updateOp(ctx.db, opId, { progressMessage: 'Picked up again after the platform API restarted' });
    try {
      if (op.opType === 'suspend') await runSuspend(ctx, target, opts, true);
      else await runResume(ctx, target, opts, true);
    } catch (err) {
      await failTransitionOp(ctx.db, opId, op.tenantId, err);
    }
  });
  return began ? 'resumed' : 'held';
}

// ─── Archive / Restore ─────────────────────────────────────────────────

export async function archiveTenant(
  ctx: RunCtx & Partial<Pick<ServiceCtx, 'targetId' | 'backupClass'>>,
  tenantId: string,
  params: {
    /**
     * How long the final bundle is kept, in days; null keeps it until it is
     * deleted by hand ("never expire"). When it expires, the tenant is
     * deleted (tenant-archive/expiry.ts). Omitted: 90.
     */
    retentionDays?: number | null;
    triggeredByUserId?: string | null;
    /** The admin's "Notify tenant" unticked: no archive notice to the tenant. */
    suppressTenantNotification?: boolean;
    /**
     * Archive only a tenant that is still suspended, and has been since before
     * this moment — checked under the tenant's lock. For the automatic sweep,
     * whose list of due tenants may be hours old by the time it reaches one:
     * the operator may have resumed it meanwhile, or taken it out of the
     * automation. Refused with NO_LONGER_DUE.
     */
    onlyIfSuspendedBefore?: Date;
  } = {},
): Promise<{ operationId: string; snapshotId: string }> {
  return withTenantLock(ctx.db, tenantId, () => startArchive(ctx, tenantId, params));
}

async function startArchive(
  ctx: RunCtx & Partial<Pick<ServiceCtx, 'targetId' | 'backupClass'>>,
  tenantId: string,
  params: NonNullable<Parameters<typeof archiveTenant>[2]>,
): Promise<{ operationId: string; snapshotId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);
  if (tenant.status === 'archived') {
    throw new ApiError('ALREADY_ARCHIVED', 'Tenant is already archived', 409);
  }
  // Every archive, not only the sweep's: archiving tears down what a suspension
  // only switched off, and its final bundle reads the suspended tenant's mail.
  if (tenant.status !== 'suspended') {
    throw new ApiError(
      'TENANT_NOT_SUSPENDED',
      'Only a suspended tenant can be archived — suspend it first',
      409,
      { status: tenant.status },
    );
  }
  if (params.onlyIfSuspendedBefore
    && !(tenant.status === 'suspended' && tenant.suspendedAt && tenant.suspendedAt < params.onlyIfSuspendedBefore)) {
    throw new ApiError('NO_LONGER_DUE', 'Tenant is no longer suspended for long enough to be archived automatically', 409);
  }
  // An admin may have taken it out of the automation since the sweep read its
  // list. A manual archive (no `onlyIfSuspendedBefore`) is not the automation.
  if (params.onlyIfSuspendedBefore && tenant.lifecycleAutomationExempt) {
    throw new ApiError('NO_LONGER_DUE', 'Tenant is kept out of automatic archive and delete', 409);
  }

  // The final bundle goes to the tenant backup target, as every tenant bundle
  // does. Checked here, before anything is touched.
  const { resolveTenantBundleTarget } = await import('./prebundle.js');
  const target = await resolveTenantBundleTarget(ctx.db).catch((err: unknown) => {
    if (err instanceof ApiError && err.code === 'NO_SNAPSHOT_TARGET') {
      throw new ApiError(
        'NO_BACKUP_TARGET',
        'Archiving takes a final backup bundle off-site, but no tenant backup target is configured. Assign one under Backups → Targets, then retry.',
        409,
      );
    }
    throw err;
  });

  const opId = uuid();
  const snapId = uuid();
  // The archive is the tenant's final full bundle (restic, off-site). The
  // row's archivePath becomes `bundle:<id>` once the capture completes; until
  // then it carries the `bundle:pending` placeholder.
  const archivePath = 'bundle:pending';
  const retentionDays = params.retentionDays === undefined ? 90 : params.retentionDays;
  const expiresAt = retentionDays === null ? null : new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageSnapshots).values({
      id: snapId, tenantId, kind: 'pre-archive', status: 'creating',
      archivePath, expiresAt,
      label: `Archive ${new Date().toISOString().slice(0, 10)}`,
      backupClass: ctx.backupClass ?? 'tenant_snapshot',
      subsystem: 'tenant-pvc',
      // Where the bundle goes — the row's own class has no target of its own.
      targetId: target.id,
    });
    await tx.insert(storageOperations).values({
      id: opId, tenantId, opType: 'archive',
      state: 'quiescing', progressPct: 0, progressMessage: 'Preparing archive',
      snapshotId: snapId,
      params: {
        retentionDays,
        suppressTenantNotification: params.suppressTenantNotification === true,
        [AWAITING_LOCK]: true,
      },
      triggeredByUserId: params.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  await beginOp(ctx.db, opId, tenantId, 'archive', () => runArchive(ctx, opId, snapId, tenant.kubernetesNamespace));
  return { operationId: opId, snapshotId: snapId };
}

/** What became of an operation the watchdog found without a live process. */
export type ResumeOutcome =
  /** Picked up: this process is running it now. */
  | 'resumed'
  /** Another process holds its lock: it was only slow, or has just been picked up. */
  | 'held'
  /** It ended meanwhile, or is no longer the tenant's operation. */
  | 'ended'
  /** It never began: its starter did not get the lock and said so. Its claim was withdrawn. */
  | 'withdrawn'
  /** Picked up as often as an operation is; it is the watchdog's to end. */
  | 'spent'
  /** Nothing here knows how to run it again; it is the watchdog's to end. */
  | 'unknown';

/**
 * Pick an operation up again whose process is gone. Every operation run from
 * here is written so that it can be run a second time from the top, whichever
 * step the first run died in — the steps already done are passed over. Not
 * picked up here: a suspend and a resume, which run under the tenant's lock
 * (`resumeTransitionOp`), and a move, which has its own rule.
 */
export async function resumeOperation(ctx: RunCtx, opId: string): Promise<ResumeOutcome> {
  const [op] = await ctx.db
    .select({
      opType: storageOperations.opType,
      state: storageOperations.state,
      snapshotId: storageOperations.snapshotId,
      params: storageOperations.params,
      namespace: tenants.kubernetesNamespace,
      activeOpId: tenants.activeStorageOpId,
    })
    .from(storageOperations)
    .innerJoin(tenants, eq(tenants.id, storageOperations.tenantId))
    .where(eq(storageOperations.id, opId));
  if (!op || op.state === 'idle' || op.state === 'failed' || op.activeOpId !== opId) return 'ended';
  const params = op.params ?? {};
  if (params[AWAITING_LOCK] === true) return await withdrawUnstartedOp(ctx.db, opId) ? 'withdrawn' : 'ended';
  const run = await runnerFor(ctx, opId, { ...op, params });
  if (!run) return 'unknown';
  const resumes = Number(params.resumes ?? 0);
  // An operation that takes the process down with it every time must not be
  // started for ever.
  if (!Number.isFinite(resumes) || resumes >= OP_MAX_RESUMES) return 'spent';
  // The lock first, the count after: an operation another process turns out
  // to hold is not one that was resumed.
  const began = await launchOp(ctx.db, opId, async () => {
    // The run that was only slow may have finished between the look above and
    // the lock: then there is nothing to pick up, and nothing to write on it.
    if (!(await operationIsMine(ctx.db, opId))) return;
    await noteOnOp(ctx.db, opId, { resumes: resumes + 1 });
    await updateOp(ctx.db, opId, { progressMessage: 'Picked up again after the platform API restarted' });
    await run();
  });
  return began ? 'resumed' : 'held';
}

/**
 * The second run of an operation, from what its row says it is. Null when the
 * row does not say enough — a kind this release does not know, or params it
 * cannot read.
 */
async function runnerFor(
  ctx: RunCtx,
  opId: string,
  op: { readonly opType: string; readonly snapshotId: string | null; readonly params: Record<string, unknown>; readonly namespace: string },
): Promise<(() => Promise<void>) | null> {
  const { params, namespace } = op;
  const pvcName = `${namespace}-storage`;
  const text = (key: string): string | null => (typeof params[key] === 'string' && params[key] !== '' ? params[key] as string : null);
  const count = (key: string): number | null => (typeof params[key] === 'number' && Number.isFinite(params[key]) ? params[key] as number : null);

  if (op.opType === 'archive') {
    const snapId = op.snapshotId;
    return snapId ? () => runArchive(ctx, opId, snapId, namespace, true) : null;
  }
  if (op.opType === 'resize') {
    const fromMib = count('fromMib');
    const toMib = count('toMib');
    if (fromMib === null || toMib === null) return null;
    if (params.mode === 'grow_online') return () => runGrowOnline(ctx, opId, namespace, pvcName, fromMib, toMib);
    const snapId = op.snapshotId;
    if (params.mode === 'destructive' && snapId) return () => runResizeDestructive(ctx, opId, snapId, namespace, pvcName, toMib, true);
    return null;
  }
  if (op.opType === 'restore') {
    const snapshotName = text('snapshotName');
    if (params.mode === 'snapshot_revert') {
      const volumeName = text('volumeName');
      return volumeName && snapshotName
        ? () => runRestoreFromSnapshot(ctx.db, ctx.k8s, opId, namespace, volumeName, snapshotName, true)
        : null;
    }
    if (params.mode === 'retained_volume') {
      const retainedPvName = text('retainedPvName');
      const retainedVolumeName = text('retainedVolumeName');
      return retainedPvName && retainedVolumeName && snapshotName
        ? () => runRestoreFromRetained(ctx.db, ctx.k8s, opId, namespace, pvcName, { retainedPvName, retainedVolumeName, snapshotName }, true)
        : null;
    }
    // A restore of an archived tenant: it names the archive it restores from.
    const snapId = text('fromSnapshot');
    const targetGi = count('targetGi');
    if (!snapId || targetGi === null) return null;
    const [snap] = await ctx.db.select({ archivePath: storageSnapshots.archivePath }).from(storageSnapshots).where(eq(storageSnapshots.id, snapId));
    return snap ? () => runRestoreArchive(ctx, opId, snapId, snap.archivePath, namespace, targetGi, true) : null;
  }
  if (op.opType === 'fsck') {
    return typeof params.dryRun === 'boolean' ? () => runFsckOp(ctx, opId, namespace, params.dryRun === true, true) : null;
  }
  return null;
}

/**
 * The archive itself. Written so that it can be run again from the top after
 * the process that ran it died (`resumed`), whichever step it died in:
 *
 *   - scaling down again is harmless, but the replica counts written down the
 *     first time are the ones to restore on failure — taken again now, they
 *     would all be zero;
 *   - a capture that finished is on the snapshot row and is not taken again;
 *     one that was cut off is failed, its Job removed, and a new one taken;
 *   - deleting the workloads and the volume a second time finds them gone;
 *   - the tenant's cascades (mailboxes, domains, status, the tenant's own
 *     notification) are not run again when the first run finished them, and
 *     are finished — the hooks that had not ended — when it died among them.
 */
async function runArchive(
  ctx: RunCtx,
  opId: string,
  snapId: string,
  namespace: string,
  resumed = false,
): Promise<void> {
  let quiesceSnap: QuiesceSnapshot | null = null;
  let preArchiveBundleId: string | null = null;
  const guard = opGuard(ctx.db, opId);
  const { stillMine } = guard;
  const progress = async (state: typeof tenants.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await stillMine();
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
  };
  try {
    await progress('quiescing', 10, 'Scaling workloads to zero');
    // quiesce persists the pre-quiesce replica counts before scaling so a
    // force-cancel / pod restart mid-archive can unquiesce the tenant instead
    // of leaving it at 0 replicas.
    quiesceSnap = await quiesceForOp(ctx.db, ctx.k8s, opId, namespace, resumed);
    await waitForQuiesced(ctx.k8s, namespace);

    const tenantId = (await currentTenantId(ctx.db, opId))!;
    const pvcName = `${namespace}-storage`;
    preArchiveBundleId = (resumed ? await resumableArchiveBundle(ctx, snapId, namespace, pvcName) : null)
      ?? await (async () => {
        await progress('snapshotting', 30, 'Taking the final backup bundle: files, databases, mailboxes, configuration');
        return takeArchive(ctx, opId, snapId, tenantId, resumed, stillMine);
      })();

    await progress('replacing', 70, 'Removing workloads and the volume');
    // Delete PVC last so deployments releasing claims don't race.
    await deleteAllDeploymentsCronJobsServices(ctx.k8s, namespace);
    await stillMine();
    try {
      await ctx.k8s.core.deleteNamespacedPersistentVolumeClaim({ name: pvcName, namespace } as Parameters<typeof ctx.k8s.core.deleteNamespacedPersistentVolumeClaim>[0]);
    } catch (err) {
      if (!is404(err)) throw err;
    }
    // And the volume itself. The tenant storage class keeps a volume whose
    // claim is deleted (reclaimPolicy Retain), so the claim's delete used to
    // leave the PV Released and the Longhorn volume, with all the tenant's
    // data, in place until the tenant was deleted. The final bundle is the
    // restore source now (restore builds a fresh volume from it).
    const { reapNamespaceVolumes, realReapDeps } = await import('../tenant-lifecycle/reap-namespace-volumes.js');
    await reapNamespaceVolumes(realReapDeps(ctx.k8s), namespace);

    // The tenant's own cascades: mail accounts, mail domains, DNS zones,
    // domains, deployments, the status and the tenant's notice.
    await progress('archiving', 90, 'Removing mailboxes, mail domains and DNS zones');
    await stillMine();
    const cascades = await import('../tenant-lifecycle/cascades.js');
    const cascadeCtx = {
      db: ctx.db,
      k8s: ctx.k8s,
      suppressTenantNotification: await suppressNoticeFor(ctx.db, opId),
    };
    if (resumed) {
      // Not again when the first run did them — and to their end when it died
      // among them: the tenant's status is stamped by one hook, with others
      // after it.
      await cascades.applyOnceSince(cascadeCtx, tenantId, namespace, 'archived', await startOf(ctx.db, opId));
    } else {
      await cascades.applyArchived(cascadeCtx, tenantId, namespace);
    }
    // Nobody signs in to an archived tenant: end the sessions it has.
    const { endTenantSessions } = await import('../tenant-archive/sessions.js');
    await endTenantSessions(ctx.db, tenantId);

    await stillMine();
    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100, progressMessage: 'Archive complete', completedAt: new Date(),
    });
    await ctx.db.update(tenants).set({
      storageLifecycleState: 'idle',
      activeStorageOpId: null,
    }).where(eq(tenants.id, tenantId));
  } catch (err) {
    if (!(await guard.failureIsMine(err))) return;
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    // Settle the archive snapshot row. If the bundle DID capture before the
    // failure, keep the row pointing at it (it IS the archive — NOT reaped on
    // failure); otherwise mark failed. Unlike resize, archive never reaps the
    // bundle on success — it's the long-lived restore source.
    await ctx.db.update(storageSnapshots)
      .set(preArchiveBundleId
        ? { status: 'ready', archivePath: `bundle:${preArchiveBundleId}`, lastError: persisted }
        : { status: 'failed', lastError: persisted })
      .where(eq(storageSnapshots.id, snapId))
      .catch(() => {});
    await unquiesceBestEffort(ctx.db, ctx.k8s, opId, namespace, quiesceSnap);
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'failed', null);
  }
}

/** Is `bundleId` an archive's own whole bundle (not an older files-only one)? */
async function isWholeArchive(db: Database, bundleId: string): Promise<boolean> {
  const [job] = await db.select({ systemTrigger: backupJobs.systemTrigger }).from(backupJobs).where(eq(backupJobs.id, bundleId));
  return job?.systemTrigger === 'pre_archive';
}

/** The admin's "Notify tenant" choice, as the archive operation recorded it. */
async function suppressNoticeFor(db: Database, opId: string): Promise<boolean> {
  const [op] = await db.select({ params: storageOperations.params }).from(storageOperations).where(eq(storageOperations.id, opId));
  return (op?.params as { suppressTenantNotification?: unknown } | null)?.suppressTenantNotification === true;
}

/**
 * The bundle a resumed archive goes on with: the one its first run took. An
 * archive started before archives took everything holds a files-only bundle;
 * while the volume is still there, a whole one is taken instead (null), so the
 * teardown never removes mail the bundle does not hold. Once the volume is
 * gone the first run was already tearing down — on the files-only bundle.
 */
async function resumableArchiveBundle(ctx: RunCtx, snapId: string, namespace: string, pvcName: string): Promise<string | null> {
  const bundleId = await bundleOnSnapshot(ctx.db, snapId);
  if (!bundleId || await isWholeArchive(ctx.db, bundleId)) return bundleId;
  try {
    await ctx.k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace } as Parameters<typeof ctx.k8s.core.readNamespacedPersistentVolumeClaim>[0]);
    return null;
  } catch (err) {
    if (is404(err)) return bundleId;
    throw err;
  }
}

/** The bundle a finished capture left on an operation's snapshot row, or null. */
async function bundleOnSnapshot(db: Database, snapId: string): Promise<string | null> {
  const [taken] = await db
    .select({ status: storageSnapshots.status, archivePath: storageSnapshots.archivePath })
    .from(storageSnapshots)
    .where(eq(storageSnapshots.id, snapId));
  if (taken?.status !== 'ready' || !taken.archivePath?.startsWith('bundle:') || taken.archivePath === 'bundle:pending') return null;
  return taken.archivePath.slice('bundle:'.length);
}

/**
 * Capture the archive's files bundle and note it on the snapshot row. Returns
 * the bundle. `stillMine` is asked again once the capture — the long part —
 * is over, before anything is written.
 */
async function takeArchive(
  ctx: RunCtx,
  opId: string,
  snapId: string,
  tenantId: string,
  resumed: boolean,
  stillMine: () => Promise<void>,
): Promise<string> {
  const [op] = await ctx.db.select({ params: storageOperations.params, createdAt: storageOperations.createdAt })
    .from(storageOperations).where(eq(storageOperations.id, opId)).limit(1);
  if (resumed) {
    // The capture the dead process was in the middle of: nobody is waiting for
    // it, its Job may still hold the volume, and its row would say "running"
    // until the retention sweep reports it as a failed backup a day later.
    const { settleInterruptedCaptures } = await import('./prebundle.js');
    await settleInterruptedCaptures(ctx.db, ctx.k8s, tenantId, op?.createdAt ?? new Date(0));
  }
  // The archive is the tenant's FULL final bundle — files (with the databases'
  // data), mailboxes with their mail, configuration, TLS secrets — kept for
  // the archive's window, or until deleted by hand (null). After this the
  // volume, the mailboxes and the domains are removed; it is the only copy.
  const recorded = (op?.params as { retentionDays?: number | null } | null)?.retentionDays;
  const retentionDays = recorded === undefined ? 90 : recorded;
  const { withMailCaptureLogin } = await import('../tenant-archive/mail-capture-window.js');
  const bundle = await withMailCaptureLogin(ctx.db, tenantId, () => captureArchiveBundle({
    db: ctx.db,
    k8s: ctx.k8s,
    tenantId,
    label: `Archive ${new Date().toISOString().slice(0, 10)}`,
    retentionDays,
  }));
  // `partial` means a component did not capture in full — the mail of one
  // mailbox, the files. Nothing is removed without the whole archive.
  if (bundle.status !== 'completed') {
    throw new ApiError(
      'SNAPSHOT_INCOMPLETE',
      `The final bundle ${bundle.bundleId} finished '${bundle.status}', not 'completed' — nothing was removed. Check the bundle's components under Backups → Tenants, then archive again.`,
      500,
    );
  }
  await stillMine();
  await ctx.db.update(storageSnapshots).set({
    status: 'ready',
    archivePath: `bundle:${bundle.bundleId}`,
    sizeBytes: String(bundle.sizeBytes),
    sha256: null,
  }).where(eq(storageSnapshots.id, snapId));
  return bundle.bundleId;
}

async function deleteAllDeploymentsCronJobsServices(k8s: K8sClients, namespace: string): Promise<void> {
  const depList = await (k8s.apps as unknown as { listNamespacedDeployment: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }> })
    .listNamespacedDeployment({ namespace, labelSelector: 'platform.io/managed=true' });
  for (const d of depList.items ?? []) {
    if (d.metadata?.name) {
      await (k8s.apps as unknown as { deleteNamespacedDeployment: (a: { name: string; namespace: string }) => Promise<unknown> })
        .deleteNamespacedDeployment({ name: d.metadata.name, namespace }).catch(() => {});
    }
  }
  const cjList = await (k8s.batch as unknown as { listNamespacedCronJob: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }> })
    .listNamespacedCronJob({ namespace, labelSelector: 'platform.io/managed=true' });
  for (const c of cjList.items ?? []) {
    if (c.metadata?.name) {
      await (k8s.batch as unknown as { deleteNamespacedCronJob: (a: { name: string; namespace: string }) => Promise<unknown> })
        .deleteNamespacedCronJob({ name: c.metadata.name, namespace }).catch(() => {});
    }
  }
  const svcList = await k8s.core.listNamespacedService({ namespace, labelSelector: 'platform.io/managed=true' });
  for (const s of (svcList as { items?: Array<{ metadata?: { name?: string } }> }).items ?? []) {
    if (s.metadata?.name) {
      await k8s.core.deleteNamespacedService({ name: s.metadata.name, namespace } as Parameters<typeof k8s.core.deleteNamespacedService>[0]).catch(() => {});
    }
  }
}

/**
 * Restore an archived tenant from their most recent pre-archive snapshot.
 * Creates a new PVC (default: the tenant's own size, as provisioning and its
 * storage quota have it; admin can override),
 * extracts the tarball, flips tenant.status back to 'active'. Deployments
 * are NOT automatically redeployed — the caller should trigger the normal
 * deployment reconciler after restore.
 */
export async function restoreArchivedTenant(
  ctx: ServiceCtx,
  tenantId: string,
  params: { newGi?: number; triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string; snapshotId: string }> {
  return withTenantLock(ctx.db, tenantId, () => startRestoreArchived(ctx, tenantId, params));
}

async function startRestoreArchived(
  ctx: ServiceCtx,
  tenantId: string,
  params: NonNullable<Parameters<typeof restoreArchivedTenant>[2]>,
): Promise<{ operationId: string; snapshotId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);
  if (tenant.status !== 'archived') {
    throw new ApiError('NOT_ARCHIVED', 'Tenant is not in archived state', 409);
  }

  const [snap] = await ctx.db.select().from(storageSnapshots).where(
    and(eq(storageSnapshots.tenantId, tenantId), eq(storageSnapshots.kind, 'pre-archive'), eq(storageSnapshots.status, 'ready')),
  ).orderBy(desc(storageSnapshots.createdAt)).limit(1);
  if (!snap) {
    throw new ApiError('NO_ARCHIVE_SNAPSHOT', 'No ready pre-archive snapshot found — the archive window may have expired', 404);
  }

  const opId = uuid();
  const targetGi = params.newGi ?? await tenantStorageGi(ctx.db, tenant);
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId, tenantId, opType: 'restore',
      state: 'replacing', progressPct: 0, progressMessage: 'Recreating PVC',
      snapshotId: snap.id,
      params: { fromSnapshot: snap.id, targetGi, [AWAITING_LOCK]: true },
      triggeredByUserId: params.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'replacing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  await beginOp(ctx.db, opId, tenantId, 'restore', () => runRestoreArchive(ctx, opId, snap.id, snap.archivePath, tenant.kubernetesNamespace, targetGi));
  return { operationId: opId, snapshotId: snap.id };
}

/**
 * Phase 5 of the snapshot-storage overhaul: pick the right restore
 * store for a given snapshot row.
 *
 *   - target_id IS NOT NULL (Phase 3+ rows): resolve via
 *     `resolveSnapshotStoreByTargetId` so restore reads from the EXACT
 *     target that originally received the upload, regardless of how
 *     class assignments may have changed since.
 *   - target_id IS NULL (legacy pre-Phase-3 rows): fall back to
 *     `ctx.store` (the legacy single-active-target / hostpath
 *     resolver). These rows have `archive_path` in the old layout
 *     (`<tenantId>/<snapId>.tar.gz` without per-class prefix).
 *
 * Throws TARGET_REMOVED if the stamped target was deleted (the
 * snapshot row's target_id was nulled by ON DELETE SET NULL but the
 * caller passed an out-of-date snap object).
 */
async function resolveRestoreStore(
  ctx: ServiceCtx,
  snap: { id: string; targetId: string | null; backupClass: string; subsystem?: string | null },
): Promise<SnapshotStore> {
  if (!snap.targetId) {
    // target_id is NULL. Two ways this can happen:
    //   (a) the row predates Phase 3 — column existed but was never
    //       stamped because the snapshot was created before the
    //       per-class resolver shipped. Detect this via `subsystem`,
    //       which Phase 1 added with a NOT NULL default — pre-Phase-1
    //       rows have it NULL.
    //   (b) the row WAS stamped under Phase 3+ but the target was
    //       since deleted (ON DELETE SET NULL fired). Surface as
    //       TARGET_REMOVED so the operator knows the archive is in
    //       an orphaned bucket that requires manual recovery.
    //
    // The previous silent fallback to `ctx.store` (the legacy single-
    // active-target store) for case (b) led to mysterious restores
    // pulling from the WRONG bucket — which an operator who'd
    // deliberately retired a target would never expect.
    if (snap.subsystem) {
      // Phase 3+ row whose target_id was nulled → target deleted.
      throw new ApiError(
        'TARGET_REMOVED',
        `Snapshot ${snap.id} was uploaded to a backup target that has since been deleted. ` +
        `Manual recovery required: locate the archive in the original target's bucket/share, ` +
        `re-create the backup-config pointing at that storage, then re-stamp this snapshot's target_id.`,
        410,
      );
    }
    // Pre-Phase-3 row (subsystem NULL) — keep the legacy fallback.
    return ctx.store;
  }
  const { resolveSnapshotStoreByTargetId } = await import('./snapshot-store.js');
  const cls = snap.backupClass as import('@insula/api-contracts').SnapshotClass;
  // Phase 11: pass k8s ctx so CIFS-backed restore can do stat/delete/sidecar.
  const store = await resolveSnapshotStoreByTargetId(ctx.db, snap.targetId, cls, {
    k8sCtx: { k8s: ctx.k8s, namespace: ctx.platformNamespace },
  });
  if (!store) {
    throw new ApiError(
      'TARGET_REMOVED',
      `Snapshot ${snap.id} was uploaded to target ${snap.targetId} which has since been deleted. ` +
      `Manual recovery required: locate the archive in the original target's bucket.`,
      410,
    );
  }
  return store;
}

/**
 * Bring an archived tenant's files back. Can be run again from the top after
 * the process that ran it died (`resumed`): the claim is left alone when it is
 * there, the restore Job the dead process started is waited for rather than
 * started a second time, and a tenant that already reads restored is not put
 * through the restore again — its cascades are finished, not repeated.
 */
async function runRestoreArchive(
  ctx: RunCtx,
  opId: string,
  snapId: string,
  archivePath: string,
  namespace: string,
  newGi: number,
  resumed = false,
): Promise<void> {
  const pvcName = `${namespace}-storage`;
  const guard = opGuard(ctx.db, opId);
  try {
    // Validate the archive is restorable BEFORE recreating the PVC — an
    // unrestorable archive (legacy tar, or a `bundle:pending` row whose
    // capture never completed) must not leave an empty orphan PVC behind.
    const bundleId = archivePath.startsWith('bundle:')
      ? archivePath.slice('bundle:'.length)
      : null;
    if (!bundleId || bundleId === 'pending') {
      throw new ApiError(
        'ARCHIVE_NOT_RESTORABLE',
        `Archive ${snapId} is a legacy tar archive or never completed (archivePath='${archivePath}') and is no longer restorable.`,
        409,
      );
    }
    // Recreate on the TENANT storage class (`longhorn-tenant`, replicas=1 for
    // LOCAL), not the platform default (`longhorn`, replicas=3) — the original
    // PVC was deleted at archive time, so there's nothing to read back; map
    // from the namespace the same way provisioning does.
    const tenantId = (await currentTenantId(ctx.db, opId))!;
    const [tenant] = await ctx.db.select({ status: tenants.status, archivedAt: tenants.archivedAt }).from(tenants).where(eq(tenants.id, tenantId));
    // The files are back and the tenant has been told so: a run picked up
    // here has only the bookkeeping left. Restoring again would write the
    // archive over whatever the tenant has done since.
    if (!(resumed && tenant?.status !== 'archived')) {
      // A volume may be there all the same: the empty one an earlier release's
      // integrity sweep created for every archived tenant, of a size it picked.
      // `applyPVC` leaves an existing claim alone, so the restore would go into
      // that — and fail when the files do not fit. One that was never written to
      // is removed first, and the tenant gets the size asked for; one that holds
      // anything is used as it is.
      const { inspectArchivedVolume, removeUnusedVolume } = await import('./archived-volume.js');
      const leftover = await inspectArchivedVolume(ctx.k8s, namespace, tenant?.archivedAt ?? null);
      await guard.stillMine();
      if (leftover.kind === 'unused') await removeUnusedVolume(ctx.k8s, namespace, leftover);

      const { applyPVC, selectTenantStorageClass } = await import('../k8s-provisioner/service.js');
      const storageClass = selectTenantStorageClass(namespace);
      await applyPVC(ctx.k8s, namespace, String(newGi), storageClass);
      await guard.stillMine();
      await updateOp(ctx.db, opId, { state: 'restoring', progressPct: 30, progressMessage: 'Restoring data from snapshot' });

      // The PVC was just recreated above; restore the bundle's files into it.
      await restoreFilesBundleIntoPvc({
        db: ctx.db,
        k8s: ctx.k8s,
        bundleId,
        tenantId,
        namespace,
        pvcName,
        resumed,
        onProgress: async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); },
      });
    }

    // An archive taken whole (its bundle is the archive's own, `pre_archive`)
    // brings everything back: what the archive removed beyond the volume.
    // One from before — a files-only bundle, its mailboxes deleted with their
    // rows — brings back the files only, as it always did.
    const whole = await isWholeArchive(ctx.db, bundleId);
    const problems: string[] = [];
    if (whole && !(resumed && tenant?.status !== 'archived')) {
      const encryptionKey = process.env.PLATFORM_ENCRYPTION_KEY ?? '';
      await guard.stillMine();
      await updateOp(ctx.db, opId, { progressPct: 55, progressMessage: 'Publishing the DNS zones again' });
      const { republishTenantZones } = await import('../tenant-archive/restore-dns.js');
      const dns = await republishTenantZones(ctx.db, tenantId, encryptionKey);
      problems.push(...dns.failures.map((f) => `DNS: ${f}`));

      await guard.stillMine();
      await updateOp(ctx.db, opId, { progressPct: 65, progressMessage: 'Rebuilding mail domains and mailboxes, importing their mail' });
      const { restoreTenantMail } = await import('../tenant-archive/restore-mail.js');
      const mail = await restoreTenantMail(ctx.db, tenantId, bundleId, encryptionKey);
      problems.push(...mail.failures.map((f) => `Mail: ${f}`));
    }

    // Phase A1: dispatch the explicit `restored` transition so the
    // hook_runs audit trail records this as restore-from-archive
    // rather than plain unsuspend. tenants-status-stamp hook writes
    // status='active' + clears archivedAt; here we only clear the
    // storage-lifecycle state. Before the operation reads complete: one
    // that died between the two would otherwise be an ended operation on a
    // tenant still archived, which nothing picks up.
    await guard.stillMine();
    const cascades = await import('../tenant-lifecycle/cascades.js');
    if (resumed) {
      // Also when the tenant already reads restored: its status is stamped by
      // one hook, and the ones after it had not run if the process died there.
      await cascades.applyOnceSince({ db: ctx.db, k8s: ctx.k8s }, tenantId, namespace, 'restored', await startOf(ctx.db, opId));
    } else {
      await cascades.applyRestored({ db: ctx.db, k8s: ctx.k8s }, tenantId, namespace);
    }

    if (whole) {
      // After the tenant reads active again: a deploy refuses a tenant that
      // is not.
      await guard.stillMine();
      await updateOp(ctx.db, opId, { progressPct: 85, progressMessage: 'Deploying the applications again' });
      const { redeployTenantWorkloads } = await import('../tenant-archive/restore-workloads.js');
      const apps = await redeployTenantWorkloads(ctx.db, ctx.k8s, tenantId, namespace);
      problems.push(...apps.failures.map((f) => `Application: ${f}`));
    }

    await guard.stillMine();
    await updateOp(ctx.db, opId, {
      state: 'idle', progressPct: 100,
      progressMessage: !whole
        ? 'Files restored. This archive is from before archives held everything: redeploy the applications and recreate the mailboxes from the tenant page.'
        : problems.length === 0
          ? 'Restored: files, databases, applications, mailboxes with their mail, domains. Mailboxes need new passwords.'
          : `Restored, with ${problems.length} problem(s): ${problems.slice(0, 5).join(' · ')}${problems.length > 5 ? ' …' : ''}`,
      completedAt: new Date(),
    });
    await ctx.db.update(tenants).set({
      storageLifecycleState: 'idle',
      activeStorageOpId: null,
    }).where(eq(tenants.id, tenantId));
  } catch (err) {
    if (!(await guard.failureIsMine(err))) return;
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, { state: 'failed', lastError: persisted, completedAt: new Date() });
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'failed', null);
  }
}

// ─── Filesystem check / repair (fsck) ──────────────────────────────────

/**
 * Look up the PV name + node placement + fsType for a tenant's tenant
 * PVC. Used by both fsck flows. Returns null if the PVC isn't bound
 * yet or Longhorn doesn't have a record.
 */
async function locateTenantVolume(
  ctx: RunCtx,
  namespace: string,
  pvcName: string,
): Promise<{ volumeName: string; nodeName: string; fsType: string } | null> {
  // PVC → volumeName
  let pvc;
  try {
    pvc = await ctx.k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
  } catch {
    return null;
  }
  const pvcShape = pvc as { spec?: { volumeName?: string } };
  const volumeName = pvcShape.spec?.volumeName;
  if (!volumeName) return null;

  // PV → fsType from CSI volumeAttributes
  let fsType = 'unknown';
  try {
    const pv = await (ctx.k8s.core as unknown as {
      readPersistentVolume: (a: { name: string }) => Promise<{ spec?: { csi?: { volumeAttributes?: Record<string, string> } } }>;
    }).readPersistentVolume({ name: volumeName });
    fsType = pv.spec?.csi?.volumeAttributes?.fsType ?? 'unknown';
  } catch { /* fsType stays unknown — runFsck will reject */ }

  // Longhorn Volume CR → currentNodeID (where /dev/longhorn/<vol> exists
  // when attached). When detached, currentNodeID is empty string ""
  // (NOT undefined), so the `??` operator does NOT fall through to
  // ownerID — we have to check truthiness explicitly. ownerID is
  // populated even when detached (set to the node Longhorn picks as
  // the volume's "owner" — a viable attach target).
  let nodeName = '';
  try {
    const lhVol = await (ctx.k8s.custom as unknown as {
      getNamespacedCustomObject: (a: {
        group: string; version: string; namespace: string; plural: string; name: string;
      }) => Promise<{ status?: { currentNodeID?: string; ownerID?: string } }>;
    }).getNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumes', name: volumeName,
    });
    const currentNode = lhVol.status?.currentNodeID;
    const ownerNode = lhVol.status?.ownerID;
    nodeName = (currentNode && currentNode.length > 0)
      ? currentNode
      : (ownerNode && ownerNode.length > 0 ? ownerNode : '');
  } catch { /* fall through — empty nodeName fails below */ }

  if (!nodeName) return null;
  return { volumeName, nodeName, fsType };
}

/**
 * Dry-run filesystem check. Quiesces the tenant (xfs_repair / e2fsck
 * refuse to run on mounted FS, even with -n), runs the check-only
 * tool against the Longhorn block device, then unquiesces.
 *
 * Reports back via storage_operations.progressMessage / lastError.
 * The full tool output is appended to progressMessage when clean,
 * lastError when errors are reported.
 */
export async function fsckCheckTenant(
  ctx: ServiceCtx,
  tenantId: string,
  opts: { triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string }> {
  return withTenantLock(ctx.db, tenantId, () => startFsck(ctx, tenantId, true, opts));
}

/**
 * Repair-mode filesystem check. Same flow as check, but the tool is
 * allowed to write to the filesystem (xfs_repair without -n; e2fsck -y).
 * Operator-initiated only — the storage-lifecycle UI surfaces a
 * confirmation modal because writes here can lose data on a badly
 * damaged filesystem.
 */
export async function fsckRepairTenant(
  ctx: ServiceCtx,
  tenantId: string,
  opts: { triggeredByUserId?: string | null } = {},
): Promise<{ operationId: string }> {
  return withTenantLock(ctx.db, tenantId, () => startFsck(ctx, tenantId, false, opts));
}

async function startFsck(
  ctx: ServiceCtx,
  tenantId: string,
  dryRun: boolean,
  opts: { triggeredByUserId?: string | null },
): Promise<{ operationId: string }> {
  const tenant = await mustGetTenant(ctx.db, tenantId);
  await mustBeIdle(ctx.db, tenantId);

  const opId = uuid();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId,
      tenantId,
      opType: 'fsck',
      state: 'quiescing',
      progressPct: 0,
      progressMessage: dryRun ? 'Starting fsck (dry-run)' : 'Starting fsck repair',
      params: { dryRun, [AWAITING_LOCK]: true },
      triggeredByUserId: opts.triggeredByUserId ?? null,
    });
    await tx.update(tenants)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(eq(tenants.id, tenantId));
  });

  // Async — caller polls /admin/storage/operations/:id for progress.
  await beginOp(ctx.db, opId, tenantId, 'filesystem check', () => runFsckOp(ctx, opId, tenant.kubernetesNamespace, dryRun));
  return { operationId: opId };
}

/**
 * The check itself. Can be run again from the top after the process that ran
 * it died (`resumed`):
 *
 *   - the volume, its node and its filesystem are noted the first time, while
 *     the volume is still attached and says where it is;
 *   - the tool's Job carries the operation's id. One the dead process left
 *     running is waited for — a second tool beside it would be working on the
 *     same blocks — and with it stays the attach that process made;
 *   - with no such Job, that attach is released and the check starts over;
 *   - the tool's result is noted before the workloads are started again, so a
 *     run picked up after that does not stop the tenant a second time to find
 *     out what was already known.
 */
async function runFsckOp(
  ctx: RunCtx,
  opId: string,
  namespace: string,
  dryRun: boolean,
  resumed = false,
): Promise<void> {
  const pvcName = `${namespace}-storage`;
  let quiesceSnap: QuiesceSnapshot | null = null;
  const guard = opGuard(ctx.db, opId);
  const progress = async (state: typeof tenants.$inferSelect['storageLifecycleState'], pct: number, msg: string) => {
    await guard.stillMine();
    await updateOp(ctx.db, opId, { state, progressPct: pct, progressMessage: msg });
    await ctx.db.update(tenants)
      .set({ storageLifecycleState: state })
      .where(eq(tenants.activeStorageOpId, opId));
  };

  try {
    const noted = resumed ? await notedOnOp(ctx.db, opId) : {};
    let result = notedFsckResult(noted.fsckResult);
    if (result) {
      quiesceSnap = await writtenQuiesceSnapshot(ctx.db, opId);
    } else {
      // Locate the volume BEFORE quiesce so we know where to schedule
      // the fsck Pod. The currentNodeID is captured while the volume
      // is still attached; after detach, the device path goes away
      // briefly, but the same node will re-attach when the fsck Pod
      // claims the PVC.
      const located = notedFsckVolume(noted.fsckVolume) ?? await locateTenantVolume(ctx, namespace, pvcName);
      if (!located) {
        throw new ApiError('FSCK_VOLUME_NOT_FOUND', `Tenant PVC ${pvcName} or its Longhorn volume not found`, 404);
      }
      if (located.fsType !== 'xfs' && located.fsType !== 'ext4' && located.fsType !== 'ext3' && located.fsType !== 'ext2') {
        throw new ApiError('FSCK_UNSUPPORTED_FS', `Unsupported fsType '${located.fsType}' — only xfs and ext4 are supported`, 400);
      }
      const { runFsck, fsckJobName, leftoverFsckJob } = await import('./fsck.js');
      const tenantId = (await currentTenantId(ctx.db, opId))!;
      await noteOnOp(ctx.db, opId, { fsckVolume: located });

      await progress('quiescing', 5, 'Scaling workloads to zero');
      // Persist before scaling so a force-cancel mid-fsck can un-quiesce.
      quiesceSnap = await quiesceForOp(ctx.db, ctx.k8s, opId, namespace, resumed);
      await waitForQuiesced(ctx.k8s, namespace);

      const ownJob = fsckJobName(located.volumeName, dryRun, opId.slice(0, 8));
      const leftJob = resumed ? await leftoverFsckJob(ctx.k8s, tenantId, ownJob) : null;
      if (!leftJob) {
        // The attach the dead process made for its own check keeps the volume
        // from ever reading detached.
        if (resumed) await detachLonghornVolume(ctx.k8s, located.volumeName).catch(() => {});
        // Volume is detached after quiesce. fsck Pod uses hostPath
        // /dev/longhorn/<vol> which only exists when Longhorn has the
        // volume attached. Force-attach to the chosen node before
        // running fsck. Frontend stays as blockdev (default) so the
        // device file appears; nothing mounts the filesystem (xfs_repair/
        // e2fsck require unmounted), so it's safe to operate.
        // Wait for the filesystem to be genuinely unmounted (Longhorn 'detached')
        // before touching the device. waitForQuiesced only proves the POD objects
        // are gone; the umount that flushes the journal happens after. Running
        // xfs_repair -n before it completes produces a spurious "errors found" —
        // see waitForVolumeDetached for the measured timeline.
        await progress('quiescing', 20, 'Waiting for the volume to detach (flushes the filesystem journal)');
        await waitForVolumeDetached(ctx.k8s, located.volumeName);

        await progress('quiescing', 25, `Attaching volume to ${located.nodeName} for fsck`);
        await attachLonghornVolume(ctx.k8s, located.volumeName, located.nodeName);
        await waitForVolumeAttached(ctx.k8s, located.volumeName, located.nodeName);
      }

      await progress('quiescing', 30, dryRun ? `Running ${located.fsType} dry-run check` : `Running ${located.fsType} repair`);
      result = await runFsck(ctx.k8s, {
        namespace,
        volumeName: located.volumeName,
        tenantId,
        fsType: located.fsType,
        dryRun,
        nodeName: located.nodeName,
        jobName: leftJob ?? ownJob,
        adopt: leftJob !== null,
        onProgress: async (msg) => { await updateOp(ctx.db, opId, { progressMessage: msg }); },
      });
      await guard.stillMine();
      await noteOnOp(ctx.db, opId, { fsckResult: { ...result, output: result.output.slice(0, 16000) } });

      // Release the explicit attach. ensureVolumeReattached below will
      // re-attach via file-manager if the tenant has nothing else to
      // run; otherwise unquiesce restores tenant workloads which give
      // the PVC a real consumer.
      await detachLonghornVolume(ctx.k8s, located.volumeName).catch(() => {});
    }

    // ── RESTORE LEG ──
    // Deliberately NOT allowed to destroy the filesystem verdict we just paid
    // for. Previously an unquiesce throw fell into the outer catch, which
    // overwrote the op with the restore error — so a CLEAN filesystem whose
    // workloads failed to come back was reported to the operator as "fsck
    // failed", with no filesystem verdict anywhere and the wrong thing to go
    // and look at. The two facts are independent and are now recorded as two
    // facts.
    await progress('unquiescing', 85, 'Scaling workloads back up');
    let restoreError: string | null = null;
    try {
      if (quiesceSnap) await unquiesce(ctx.k8s, namespace, quiesceSnap);
      // fsck used hostPath /dev/longhorn/<vol> instead of PVC mount, so
      // Longhorn detached the volume during quiesce and has no reason
      // to re-attach unless a Pod actually consumes the PVC. If
      // unquiesce restored zero workloads (e.g. file-manager was 0
      // before fsck — its idle default — and the tenant deployment is
      // also 0), the volume is left dangling. Bump file-manager to 1
      // so the PVC has a consumer; idle-cleanup will scale it back down
      // after the inactivity window. Best-effort — failure here doesn't
      // invalidate the fsck result.
      await ensureVolumeReattached(ctx.k8s, namespace).catch((err) => {
        console.warn(`[storage-lifecycle] fsck post-attach (op ${opId}):`, err);
      });
    } catch (err) {
      restoreError = err instanceof Error ? err.message : String(err);
      console.error(`[storage-lifecycle] fsck op ${opId}: filesystem verdict '${result.verdict}' but the restore FAILED: ${restoreError}`);
      // One more try, then leave it to the workload-health reconciler, which
      // sweeps every 5 min and can re-stage the volume.
      await unquiesceBestEffort(ctx.db, ctx.k8s, opId, namespace, quiesceSnap);
    }

    // Persist the captured output. The summary is computed by the classifier so
    // the exit-code semantics live in exactly one place — see classifyFsckOutput
    // for why `xfs_repair -n` exit 1 is not a corruption signal.
    const parts = [result.summary];
    if (restoreError) {
      parts.push(
        `RESTORE FAILED after the check: ${restoreError}`,
        'The filesystem verdict above still stands — this is a separate failure.',
      );
    }
    const summary = parts.join('\n\n');
    // `errors` is the only verdict that is a filesystem problem. A failed
    // restore is an availability problem. Either makes the op red, but they
    // point the operator at different things.
    const opFailed = result.verdict === 'errors' || restoreError !== null;
    await updateOp(ctx.db, opId, {
      state: opFailed ? 'failed' : 'idle',
      progressPct: 100,
      progressMessage: opFailed ? summary : `${summary}\n\n${result.output}`.slice(0, 8000),
      lastError: opFailed
        ? [restoreError ? `restore: ${restoreError}` : null, result.output]
          .filter(Boolean).join('\n\n').slice(0, 16000)
        : null,
      completedAt: new Date(),
    });

    // ★ The tenant's storage LIFECYCLE state is not the filesystem verdict.
    //
    // `mustBeIdle` requires strictly 'idle', and it gates startFsck itself — so
    // leaving the tenant 'failed' because a read-only CHECK found something
    // locks the operator out of the REPAIR that would fix it, and out of
    // resize / restore / suspend / resume / archive as well. A diagnostic must
    // never take away the remedy. The verdict lives on the op row (which shows
    // red in the UI and the task-tracker chip); the tenant only stays 'failed'
    // when its workloads are genuinely still down, because that is the state
    // the watchdog and the clear-failed valve are for.
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, restoreError ? 'failed' : 'idle', null);
  } catch (err) {
    if (!(await guard.failureIsMine(err))) return;
    const persisted = formatLifecycleError(err, 'pvc');
    await updateOp(ctx.db, opId, {
      state: 'failed', lastError: persisted, completedAt: new Date(),
    });
    // Best-effort cleanup: drop the explicit attach hold, then
    // restore workloads (falling back to the op-persisted snapshot when
    // quiesce() threw mid-flight), then ensure file-manager scales up so
    // the PVC has a Pod consumer (Longhorn re-attach).
    await detachLonghornVolumeByPvc(ctx.k8s, namespace, pvcName).catch(() => {});
    await unquiesceBestEffort(ctx.db, ctx.k8s, opId, namespace, quiesceSnap);
    await ensureVolumeReattached(ctx.k8s, namespace).catch(() => {});
    const cId = await currentTenantId(ctx.db, opId);
    if (cId) await markTenantState(ctx.db, cId, 'failed', null);
  }
}

/** A check's result as a first run noted it on the operation, or null. */
function notedFsckResult(noted: unknown): import('./fsck.js').FsckResult | null {
  const r = noted as Partial<import('./fsck.js').FsckResult> | null | undefined;
  if (!r || typeof r !== 'object') return null;
  if (r.verdict !== 'clean' && r.verdict !== 'errors' && r.verdict !== 'inconclusive') return null;
  if (typeof r.summary !== 'string' || typeof r.output !== 'string') return null;
  return r as import('./fsck.js').FsckResult;
}

/** Where a check's volume is, as a first run noted it on the operation, or null. */
function notedFsckVolume(noted: unknown): { volumeName: string; nodeName: string; fsType: string } | null {
  const v = noted as { volumeName?: unknown; nodeName?: unknown; fsType?: unknown } | null | undefined;
  if (!v || typeof v.volumeName !== 'string' || typeof v.nodeName !== 'string' || typeof v.fsType !== 'string') return null;
  if (!v.volumeName || !v.nodeName) return null;
  return { volumeName: v.volumeName, nodeName: v.nodeName, fsType: v.fsType };
}

/**
 * Force-attach (or detach) a Longhorn volume by patching the
 * `volumeattachments.longhorn.io` CR (NOT the Volume's spec.nodeID,
 * which Longhorn's mutation webhook silently clears on direct
 * patches — Longhorn 1.6+ uses a separate VolumeAttachment CR with
 * "attachment tickets" to coordinate attach/detach across competing
 * consumers).
 *
 * To attach: add a ticket keyed by `FSCK_ATTACH_TICKET` with
 *   { id, type: 'longhorn-api', nodeID, parameters: {disableFrontend:'false'} }
 * To detach: set the same ticket key to null (merge-patch removes it).
 *
 * Frontend stays "blockdev" (disableFrontend=false) so /dev/longhorn/<vol>
 * appears on the target node — fsck's hostPath relies on this device
 * file existing.
 */
const FSCK_ATTACH_TICKET = 'platform-fsck';

async function attachLonghornVolume(k8s: K8sClients, volumeName: string, nodeID: string): Promise<void> {
  const { MERGE_PATCH } = await import('../../shared/k8s-patch.js');
  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (
      a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
      mw: typeof MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedCustomObject(
    {
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumeattachments', name: volumeName,
      body: {
        spec: {
          attachmentTickets: {
            [FSCK_ATTACH_TICKET]: {
              id: FSCK_ATTACH_TICKET,
              type: 'longhorn-api',
              nodeID,
              parameters: {
                disableFrontend: 'false',
                lastAttachedBy: '',
              },
            },
          },
        },
      },
    },
    MERGE_PATCH,
  );
}

async function detachLonghornVolume(k8s: K8sClients, volumeName: string): Promise<void> {
  // null in merge-patch removes the key — clearing our ticket lets
  // Longhorn detach (assuming no other consumers hold tickets).
  const { MERGE_PATCH } = await import('../../shared/k8s-patch.js');
  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (
      a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
      mw: typeof MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedCustomObject(
    {
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumeattachments', name: volumeName,
      body: { spec: { attachmentTickets: { [FSCK_ATTACH_TICKET]: null } } },
    },
    MERGE_PATCH,
  );
}

/** Release the attach a filesystem check made for itself — for the watchdog, ending a check nobody is running. */
export async function releaseFsckAttach(k8s: K8sClients, volumeName: string): Promise<void> {
  await detachLonghornVolume(k8s, volumeName);
}

/** Convenience: look up volumeName from the tenant's PVC, then detach. */
async function detachLonghornVolumeByPvc(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
): Promise<void> {
  const pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace })
    .catch(() => null);
  const volumeName = (pvc as { spec?: { volumeName?: string } } | null)?.spec?.volumeName;
  if (!volumeName) return;
  await detachLonghornVolume(k8s, volumeName);
}

/**
 * `waitForVolumeDetached` addressed by PVC rather than PV name.
 *
 * Exported for the workload-health reconciler, whose auto-heal is "re-stage the
 * volume": it knows the tenant namespace and therefore the PVC, and must not
 * duplicate the PVC → `spec.volumeName` → Longhorn-volume resolution.
 *
 * A PVC with no bound volume is treated as detached — there is nothing attached
 * to wait for, and throwing here would abort a heal over a tenant that simply
 * has no storage yet.
 */
export async function waitForVolumeDetachedByPvc(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
  timeoutMs = 120_000,
): Promise<void> {
  const pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace })
    .catch(() => null);
  const volumeName = (pvc as { spec?: { volumeName?: string } } | null)?.spec?.volumeName;
  if (!volumeName) return;
  await waitForVolumeDetached(k8s, volumeName, timeoutMs);
}

/**
 * Wait for Longhorn to report state=attached on the expected node.
 * Times out after 60s — Longhorn typically attaches in 5-15s.
 */
async function waitForVolumeAttached(
  k8s: K8sClients,
  volumeName: string,
  expectedNode: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lhVol = await (k8s.custom as unknown as {
      getNamespacedCustomObject: (a: {
        group: string; version: string; namespace: string; plural: string; name: string;
      }) => Promise<{ status?: { state?: string; currentNodeID?: string } }>;
    }).getNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumes', name: volumeName,
    }).catch(() => ({ status: undefined }));
    if (lhVol.status?.state === 'attached' && lhVol.status?.currentNodeID === expectedNode) {
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Longhorn volume ${volumeName} did not attach to ${expectedNode} within ${timeoutMs}ms`);
}

/**
 * Wait until Longhorn reports the volume DETACHED.
 *
 * ★ This is what makes a dry-run fsck trustworthy. `waitForQuiesced` returns as
 * soon as no pod that mounts the PVC is left in the API — but the pod object
 * disappearing is not the filesystem being unmounted. kubelet's
 * `NodeUnstageVolume` (the actual `umount`, which is what flushes the XFS
 * journal and writes the unmount record) and Longhorn's subsequent detach both
 * complete AFTERWARDS.
 *
 * Measured on a real cluster (times relative, all UTC):
 *
 *   21:34:43  op created
 *   21:34:45  kernel: XFS (sdx): Unmounting Filesystem …     ← umount STARTS
 *   21:34:45.956  platform-api patches the fsck attach ticket ← same second
 *   21:34:49  xfs_repair -n runs                             ← ~4s after
 *   21:34:50→53  kubelet's CSI DetachVolume still in flight
 *   21:35:14  remount: "Starting recovery" → "Ending recovery" ← log WAS dirty
 *
 * So the check read a filesystem with an unflushed journal, and `xfs_repair -n`
 * cannot replay a log — it reported the free-block counter as inconsistent,
 * exited 1, and the tenant was marked `failed` over a healthy filesystem.
 * Waiting for `detached` means the umount has completed and the journal is on
 * disk before anything reads the device.
 *
 * Tolerates the volume having no CR at all (already fully gone) — that is
 * detached by any reasonable reading.
 */
async function waitForVolumeDetached(
  k8s: K8sClients,
  volumeName: string,
  timeoutMs = 120_000,
): Promise<void> {
  const start = Date.now();
  let lastState = 'unknown';
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    let lhVol: { status?: { state?: string; currentNodeID?: string } } | null = null;
    let absent = false;
    try {
      lhVol = await (k8s.custom as unknown as {
        getNamespacedCustomObject: (a: {
          group: string; version: string; namespace: string; plural: string; name: string;
        }) => Promise<{ status?: { state?: string; currentNodeID?: string } }>;
      }).getNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes', name: volumeName,
      });
    } catch (err) {
      // ★ FAIL CLOSED. An earlier revision did `.catch(() => null)` and treated
      // ANY error as "already detached" — which silently reintroduces the exact
      // race this function exists to close: one API-server 5xx, timeout or RBAC
      // hiccup at the wrong poll iteration and the caller proceeds to read a
      // device whose journal has not been flushed. Only a genuine "the CR is
      // gone" counts as detached; everything else keeps polling and, if it never
      // clears, times out loudly.
      const e = err as { statusCode?: number; code?: number; response?: { statusCode?: number } } | null;
      const status = e?.statusCode ?? e?.code ?? e?.response?.statusCode;
      const msg = err instanceof Error ? err.message : String(err);
      absent = status === 404 || /HTTP 404\b|\bnot found\b/i.test(msg);
      if (!absent) {
        lastError = msg;
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
    }
    // No CR at all → nothing is attached, which is detached by any reading.
    if (absent || lhVol === null) return;
    lastError = null;
    lastState = lhVol.status?.state ?? 'unknown';
    // `detaching` is explicitly NOT good enough: that is precisely the window
    // the old code ran the check in.
    if (lastState === 'detached') return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Longhorn volume ${volumeName} did not reach 'detached' within ${timeoutMs}ms (last state: '${lastState}')`
    + (lastError ? ` — last read error: ${lastError}` : '')
    + ' — refusing to operate on a volume that may still have an unflushed journal',
  );
}

/**
 * Best-effort: scale file-manager to 1 if it isn't already, so the
 * tenant PVC gains a Pod consumer and Longhorn re-attaches the volume.
 * Used after fsck (which detaches via quiesce + uses hostPath instead
 * of PVC mount, so Longhorn has no reason to keep the volume attached).
 *
 * Also bumps the file-manager last-access annotation so the
 * idle-cleanup scheduler doesn't immediately scale FM back to 0
 * (cleanup uses Deployment creationTimestamp as the floor when no
 * annotation is set — for a long-lived Deployment that's effectively
 * "idle since creation", which trips the timeout instantly).
 *
 * The idle-cleanup will scale FM back to 0 after the inactivity
 * window from NOW, so this is a transient state change — long enough
 * for Longhorn to re-attach the volume.
 */
async function ensureVolumeReattached(k8s: K8sClients, namespace: string): Promise<void> {
  try {
    const dep = await (k8s.apps as unknown as {
      readNamespacedDeployment: (a: { name: string; namespace: string }) => Promise<{ spec?: { replicas?: number } }>;
    }).readNamespacedDeployment({ name: 'file-manager', namespace });
    const current = dep.spec?.replicas ?? 0;
    // Bump the last-access annotation in BOTH cases (current=0 and
    // current>=1) so the idle-cleanup sees a fresh access timestamp
    // and doesn't reap the FM during the post-fsck attach window.
    const { recordFileManagerAccess } = await import('../file-manager/idle-cleanup.js');
    recordFileManagerAccess(namespace, k8s);
    if (current >= 1) return; // someone else already kept it up
    const { STRATEGIC_MERGE_PATCH } = await import('../../shared/k8s-patch.js');
    await (k8s.apps as unknown as {
      patchNamespacedDeploymentScale: (a: { name: string; namespace: string; body: unknown }, mw: typeof STRATEGIC_MERGE_PATCH) => Promise<unknown>;
    }).patchNamespacedDeploymentScale({
      name: 'file-manager',
      namespace,
      body: { spec: { replicas: 1 } },
    }, STRATEGIC_MERGE_PATCH);
  } catch {
    // file-manager Deployment may not exist (suspended/archived
    // tenant). The next lifecycle op or Files-page interaction will
    // recreate it; we don't try to provision it from here.
  }
}

// ─── Listing + housekeeping ────────────────────────────────────────────

export async function listSnapshotsForTenant(db: Database, tenantId: string) {
  return db.select().from(storageSnapshots).where(eq(storageSnapshots.tenantId, tenantId)).orderBy(desc(storageSnapshots.createdAt));
}

export async function listOperationsForTenant(db: Database, tenantId: string, limit = 50) {
  return db.select().from(storageOperations).where(eq(storageOperations.tenantId, tenantId)).orderBy(desc(storageOperations.createdAt)).limit(limit);
}

export async function getOperation(db: Database, opId: string) {
  const [op] = await db.select().from(storageOperations).where(eq(storageOperations.id, opId));
  return op ?? null;
}

export async function deleteSnapshot(ctx: ServiceCtx, snapshotId: string): Promise<void> {
  const [snap] = await ctx.db.select().from(storageSnapshots).where(eq(storageSnapshots.id, snapshotId));
  if (!snap) throw new ApiError('SNAPSHOT_NOT_FOUND', `Snapshot ${snapshotId} not found`, 404);
  // Refuse to delete a snapshot still being created — an in-flight archive
  // holds this snapId and would silently no-op its later "ready" update,
  // leaving an archived tenant with no restore row.
  if (snap.status === 'creating') {
    throw new ApiError('SNAPSHOT_IN_PROGRESS', `Snapshot ${snapshotId} is still being created — wait for it to finish before deleting.`, 409);
  }
  // DR safety: refuse to delete from a frozen target. The DB row is
  // not deleted either — the operator must explicitly unfreeze the
  // target before any cleanup happens.
  if (snap.targetId) {
    const { requireWritableTarget } = await import('../backup-config/writable-guard.js');
    await requireWritableTarget(ctx.db, snap.targetId);
  }
  // Use the per-target resolver so the remote archive lands in (or out
  // of) the SAME store that originally received the upload. The
  // previous ctx.store.delete() call routed every delete to the legacy
  // single-active-target store, which for Phase 3+ snapshots either
  // silently no-op'd (wrong bucket) or deleted from an unrelated
  // target. Phase 11 CIFS delete (one-shot rclone Job) was never
  // reached this way.
  if (snap.archivePath.startsWith('bundle:')) {
    // Archive / pre-resize rows hold a restic bundle id (`bundle:<id>`),
    // NOT a snapshot-store key — reap the bundle, not store.delete (which
    // would no-op on the literal "bundle:<id>" string and leak the data).
    const bundleId = snap.archivePath.slice('bundle:'.length);
    if (bundleId && bundleId !== 'pending') {
      await reapPreResizeBundle({ db: ctx.db, k8s: ctx.k8s, bundleId }).catch(() => { /* best-effort */ });
    }
  } else {
    try {
      const store = await resolveRestoreStore(ctx, snap);
      await store.delete(snap.archivePath).catch(() => { /* best-effort remote cleanup */ });
    } catch (err) {
      // TARGET_REMOVED 410 is acceptable here — the target's gone, so
      // there's nothing remote to clean up. Still delete the DB row.
      if (!(err instanceof ApiError && err.code === 'TARGET_REMOVED')) {
        throw err;
      }
    }
  }
  await ctx.db.delete(storageSnapshots).where(eq(storageSnapshots.id, snapshotId));
}

/**
 * Housekeeping: drop snapshots past their expires_at. Runs from the
 * scheduler daily. Returns count of snapshots reaped.
 */
export async function expireSnapshots(ctx: ServiceCtx): Promise<number> {
  const now = new Date();
  const due = await ctx.db.select().from(storageSnapshots).where(
    and(lte(storageSnapshots.expiresAt, now), eq(storageSnapshots.status, 'ready')),
  );
  // DR safety: pre-fetch the set of frozen target IDs ONCE rather
  // than calling requireWritableTarget per-snapshot. A daily sweep
  // with 1000 expired snapshots across 10 targets used to issue 1000
  // SELECTs; now it issues exactly 1.
  const distinctTargets = Array.from(new Set(
    due.map((s) => s.targetId).filter((t): t is string => Boolean(t)),
  ));
  const frozenTargetIds = new Set<string>();
  if (distinctTargets.length > 0) {
    const rows = await ctx.db
      .select({ id: backupConfigurations.id })
      .from(backupConfigurations)
      .where(and(
        eq(backupConfigurations.readOnly, true),
        inArray(backupConfigurations.id, distinctTargets),
      ));
    for (const r of rows) frozenTargetIds.add(r.id);
  }
  let reaped = 0;
  for (const snap of due) {
    try {
      // Skip frozen targets entirely — the DB row stays 'ready' so the
      // next sweep re-evaluates once the operator unfreezes.
      if (snap.targetId && frozenTargetIds.has(snap.targetId)) continue;
      // An archived tenant whose archive expired is deleted, bundle and all
      // (tenant-archive/expiry.ts). Its snapshot row goes with the tenant. The
      // bundle of an older archive — the tenant was restored since — expires
      // as any other.
      if (snap.kind === 'pre-archive') {
        const { deleteTenantOfExpiredArchive } = await import('../tenant-archive/expiry.js');
        const outcome = await deleteTenantOfExpiredArchive(ctx.db, ctx.k8s, snap.tenantId, snap.id);
        if (outcome === 'deleted') { reaped += 1; continue; }
        if (outcome === 'deferred') continue;
      }
      // Per-target delete (same rationale as deleteSnapshot above —
      // legacy ctx.store would route every expire to the wrong bucket
      // for Phase 3+ snapshots). TARGET_REMOVED means the target's
      // gone; still flip the DB row to expired (no remote cleanup
      // possible anyway).
      if (snap.archivePath.startsWith('bundle:')) {
        // restic bundle (archive / pre-resize) — reap the bundle, not store.delete.
        const bundleId = snap.archivePath.slice('bundle:'.length);
        if (bundleId && bundleId !== 'pending') {
          await reapPreResizeBundle({ db: ctx.db, k8s: ctx.k8s, bundleId }).catch(() => {});
        }
      } else {
        try {
          const store = await resolveRestoreStore(ctx, snap);
          await store.delete(snap.archivePath);
        } catch (err) {
          if (!(err instanceof ApiError && err.code === 'TARGET_REMOVED')) throw err;
        }
      }
      await ctx.db.update(storageSnapshots).set({ status: 'expired' }).where(eq(storageSnapshots.id, snap.id));
      reaped += 1;
    } catch {
      // Log only — don't let one stuck snapshot break the cron
    }
  }
  return reaped;
}

/**
 * Report provisioned vs actually-used storage for every tenant. The cron
 * publishes this once a week for capacity planning. For now, just
 * computes + returns — emit via logger or email in a later pass.
 */
export async function storageAuditReport(ctx: ServiceCtx): Promise<Array<{
  tenantId: string;
  namespace: string;
  provisionedGi: number;
  usedBytes: number;
  wastePct: number;
}>> {
  const rows = await ctx.db.select({
    id: tenants.id,
    ns: tenants.kubernetesNamespace,
    storageLimitOverride: tenants.storageLimitOverride,
    planId: tenants.planId,
  }).from(tenants).where(
    and(eq(tenants.status, 'active'), sql`${tenants.kubernetesNamespace} IS NOT NULL`),
  );
  const out = [];
  for (const r of rows) {
    const provisionedGi = await tenantStorageGi(ctx.db, r);
    const used = await measurePvcUsed(ctx, r.ns!);
    const provisionedBytes = provisionedGi * 1024 * 1024 * 1024;
    const wastePct = provisionedBytes > 0 ? Math.round(((provisionedBytes - used) / provisionedBytes) * 100) : 0;
    out.push({ tenantId: r.id, namespace: r.ns!, provisionedGi, usedBytes: used, wastePct });
  }
  return out;
}
