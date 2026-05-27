/**
 * Mail migration — Stalwart RocksDB DataStore node-swap pipeline.
 *
 * **2026-05-15 streamline (Phase 1 of mail-arch v2):**
 *   The pre-streamline pipeline rsynced the local-path PVC to a *new* PVC
 *   name (e.g. `stalwart-rocksdb-data-mig-XXXXXXX`) and then SSA-patched the  // ci-mail-arch: ignore
 *   Deployment to point at the new PVC. That triggered an ongoing
 *   Flux/platform-api ownership war on `template.spec.volumes` —
 *   Flux's reconcile reverted the cutover ~60s after every migration.
 *
 *   The architectural fix: **PVC name is stable** (`mail-stack-data` post-A2.5; legacy `stalwart-rocksdb-data`)
 *   across all migrations. Data moves between nodes via the **restic
 *   snapshot** that the snapshot CronJob already produces every 2 minutes.
 *   The Deployment's `template.spec.affinity` is the ONLY field that
 *   changes, and affinity is NOT declared in the manifest — so Flux's
 *   non-force SSA reconcile never touches it. Zero conflicts.
 *
 *   Trade-off: the migration takes a brief downtime (snapshot + scale-
 *   down + PVC recreate + restore on target) instead of the old "rsync
 *   while live" no-downtime path. Operator-stated RTO is 2 minutes, which
 *   this fits for typical mail volumes (<1 GiB takes ~30s to restore).
 *
 * **State machine (single path, no rsync Jobs):**
 *
 *   queued → preflight → snapshotting → scaling-down → swapping-pvc
 *     → scaling-up → verifying → done
 *
 *   On node-loss DR (auto-failover, source node unreachable), the same
 *   state machine runs; the only difference is the snapshotting step
 *   is skipped (we use the most recent CronJob snapshot).
 *
 *   POST /admin/mail/migrate    → startMailMigration({intent:'explicit', targetNode})
 *   POST /admin/mail/failover   → startMailMigration({intent:'failover'})
 *   POST /admin/mail/failback   → startMailMigration({intent:'failback'})
 *   GET  /admin/mail/migrate/:runId → getMailMigrationStatus
 */

import { randomUUID } from 'node:crypto';
import { eq, sql, isNotNull, count } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { MERGE_PATCH, strategicMergePatch } from '../../shared/k8s-patch.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import { waitForStalwartReplicaCount } from './rollout-wait.js';
import { systemSettings, emailDomains, mailboxes } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { triggerMailSnapshot } from './snapshot.js';
import { parseQuantity } from './mail-pvc.js';
import { readStalwartCredentials } from './credentials.js';

const MAIL_NAMESPACE = 'mail';
const SETTINGS_ID = 'system';
const DEPLOYMENT_NAME = 'stalwart-mail';
const BULWARK_DEPLOYMENT_NAME = 'bulwark';
/**
 * Mail-stack co-location list. Every Deployment here gets the same
 * nodeSelector pin to mailActiveNode and moves together on failover.
 * Stalwart and Bulwark must always land on the same node (Bulwark
 * talks to Stalwart via JMAP; co-location minimises latency + keeps
 * the failover primitive atomic). See ADR-043 + project_nfs_dropped
 * memory.
 */
export const MAIL_STACK_DEPLOYMENTS = [
  DEPLOYMENT_NAME,
  BULWARK_DEPLOYMENT_NAME,
] as const;
// A2.5 (2026-05-25): mail-stack consolidation — Stalwart + Bulwark both
// mount this single PVC with subPaths (stalwart/, bulwark/). Legacy
// name was `stalwart-rocksdb-data`; cutover via
// scripts/mail-stack-consolidate.sh + the A2.5 manifest commit.
const MAIL_PVC_NAME = 'mail-stack-data';
const ALLOW_RESTORE_ANNOTATION = 'mail.platform/allow-restore';
/**
 * When set on the Stalwart pod template, the restore-state init container
 * runs `restic restore <id>` instead of `restic restore latest`. Used by
 * the per-snapshot restore flow from /backups/mail. Cleared at the same
 * time as ALLOW_RESTORE_ANNOTATION on migration success.
 */
const RESTORE_SNAPSHOT_ID_ANNOTATION = 'mail.platform/restore-snapshot-id';
const DISK_HEADROOM_RATIO = 1.25; // target must have 25% more free than used

/**
 * Field-manager attribution.
 *
 * - `MIGRATION_DEPLOYMENT_PATCH` — strategic-merge-patch for `spec.replicas`
 *   updates. No SSA force needed: replicas is owned by the controller
 *   (deployment-controller) by default; strategic-merge-patch with a
 *   named field-manager performs an Update that the controller respects.
 *
 * - `MIGRATION_AFFINITY_PATCH` — strategic-merge-patch for
 *   `template.spec.affinity` + `metadata.annotations`. Neither field is
 *   declared in the manifest, so Flux's non-force SSA reconcile never
 *   re-claims them. Strategic-merge is sufficient — we don't need SSA.
 */
const MIGRATION_DEPLOYMENT_PATCH = strategicMergePatch('platform-api.migration');
const MIGRATION_AFFINITY_PATCH = strategicMergePatch('platform-api.migration');

// ── Type imports ──────────────────────────────────────────────────────────────

type CoreV1Api = import('@kubernetes/client-node').CoreV1Api;
type BatchV1Api = import('@kubernetes/client-node').BatchV1Api;
type AppsV1Api = import('@kubernetes/client-node').AppsV1Api;

export interface MigrationDeps {
  readonly core: CoreV1Api;
  readonly batch: BatchV1Api;
  readonly apps: AppsV1Api;
  readonly db: Database;
  /** Pass-through so safety snapshot can load its own k8s tenants. */
  readonly kubeconfigPath: string | undefined;
  readonly logger?: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
  /**
   * Authenticated user id from the JWT. When set, the state machine
   * writes a task-center row (kind='mail.migration') so the operator
   * gets a chip indicator + progress modal. When null (DR-watcher /
   * system trigger) the migration runs without a chip entry.
   */
  readonly userId?: string | null;
}

// ── Row shape for mail_migration_runs ─────────────────────────────────────────

type MigrationRunRow = Record<string, unknown> & {
  id: string;
  source_node: string;
  target_node: string;
  state: string;
  current_step: string | null;
  progress_bytes: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  error_message: string | null;
};

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Migration intent discriminator. The `explicit` intent requires the
 * caller to pass `targetNode`; `failover` and `failback` resolve the
 * target node from `system_settings` (mailSecondaryNode|mailTertiaryNode
 * for failover; mailPrimaryNode for failback).
 */
export type MigrationIntent =
  | { readonly kind: 'explicit'; readonly targetNode: string; readonly newGiB?: number }
  | { readonly kind: 'failover' }
  | { readonly kind: 'failback' };

const INTENT_TRIGGERED_BY: Record<MigrationIntent['kind'], string> = {
  explicit: 'operator',
  failover: 'manual-failover',
  failback: 'manual-failback',
};

export async function startMailMigration(
  intent: MigrationIntent,
  deps: MigrationDeps,
  opts: MigrationOptions = {},
): Promise<{ runId: string; taskId: string | null }> {
  const { db, core } = deps;

  // Guard: no concurrent migration
  const activeRows = await db.execute<{ id: string }>(sql`
    SELECT id FROM mail_migration_runs
    WHERE state NOT IN ('done', 'failed', 'rolled-back')
    LIMIT 1
  `);
  if ((activeRows as unknown as { rows: { id: string }[] }).rows?.length) {
    throw new ApiError('MAIL_MIGRATION_ALREADY_RUNNING', 'A migration is already in progress', 409);
  }

  // Resolve target node from intent. Failover/failback look up
  // settings; explicit takes the caller-supplied targetNode verbatim.
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
  const targetNode = resolveTargetNode(intent, row);
  const newGiB = intent.kind === 'explicit' ? intent.newGiB : undefined;
  const triggeredBy = INTENT_TRIGGERED_BY[intent.kind];

  // Validate target node exists in the cluster.
  try {
    await core.readNode({ name: targetNode });
  } catch {
    throw new ApiError('MAIL_NODE_NOT_FOUND', `Node '${targetNode}' not found in the cluster`, 404);
  }

  // Resolve source node. Recovery mode reads the ACTUAL PVC bound-node
  // because system_settings.mailActiveNode is stale when the stack is
  // broken (the whole reason recovery is being triggered).
  let sourceNode: string | null;
  if (opts.recoverFromBrokenState) {
    sourceNode = await readActualPvcBoundNode(core);
    if (!sourceNode) {
      throw new ApiError(
        'MAIL_RECOVERY_NO_PVC',
        `Recovery requires the mail-stack-data PVC to exist (so its current bound-node can be read). Found no PVC — bootstrap mail first.`,
        409,
      );
    }
  } else {
    sourceNode = row?.mailActiveNode ?? row?.mailPrimaryNode ?? null;
    if (!sourceNode) {
      throw new ApiError('MAIL_NO_ACTIVE_NODE', 'No active mail node is configured in system_settings', 409);
    }
  }
  // Defense-in-depth: the Zod schema (`kubernetesNodeNameSchema`)
  // enforces RFC 1123 on inbound API payloads, but `sourceNode` is
  // read from `system_settings.mailActiveNode` and that column may
  // have been written by a pre-validation code path.
  if (!/^[a-z0-9]([a-z0-9-.]{0,251}[a-z0-9])?$/.test(sourceNode)) {
    throw new ApiError(
      'MAIL_INVALID_SOURCE_NODE',
      `Source mail node '${sourceNode}' is not a valid RFC 1123 hostname — refusing to migrate. Fix system_settings.mailActiveNode manually.`,
      500,
    );
  }
  // Same-node check skipped in recovery mode: operator may legitimately
  // want to recover to the node system thinks is active (when the pod
  // is actually broken on a different node).
  //
  // Also skipped when restoring a specific snapshot — in-place rollback
  // (snapshot → same node) is the natural operator UX from /backups/mail,
  // and the PVC swap + restore-state init flow handles same-node
  // correctly (PVC is recreated empty, init container restores from
  // the chosen snapshot id).
  const allowSameNode = opts.recoverFromBrokenState || Boolean(opts.restoreSnapshotId);
  if (!allowSameNode && sourceNode === targetNode) {
    throw new ApiError('MAIL_MIGRATION_SAME_NODE', 'Source and target nodes are the same', 400);
  }

  // Backup-target check skipped in recovery mode: by definition we're
  // recovering from a broken state where the safety backup is moot
  // (source data may already be lost). The snapshot step is also
  // implicitly skipped via skipFreshSnapshot=true (enforced below).
  if (!opts.recoverFromBrokenState && !row?.mailSnapshotBackupStoreId) {
    throw new ApiError(
      'MAIL_MIGRATION_NO_BACKUP_TARGET',
      'Mail migration requires a configured backup target. Go to Settings → Backups to add a CIFS / S3 / Hetzner-Storage-Box BackupStore, then Email Management → Operations → Backups to select it.',
      412, // Precondition Failed
    );
  }

  // Recovery mode always implies skipFreshSnapshot=true. Caller may
  // have already set it; enforce here so the precondition check above
  // and the state-machine step 2 agree.
  const effectiveOpts: MigrationOptions = opts.recoverFromBrokenState
    ? { ...opts, skipFreshSnapshot: true }
    : opts;

  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO mail_migration_runs
      (id, source_node, target_node, state, triggered_by, current_step)
    VALUES (${runId}, ${sourceNode}, ${targetNode}, 'queued', ${triggeredBy}, 'preflight')
  `);

  // Task-center wiring (2026-05-16): write a task row keyed by runId so
  // re-triggers are idempotent. The chip's modalProps include runId
  // (the existing MailMigrationProgressModal polls /admin/mail/migrate/:runId).
  let taskId: string | null = null;
  if (deps.userId) {
    try {
      const { start: startTask } = await import('../tasks/service.js');
      const { toSafeText } = await import('@k8s-hosting/api-contracts');
      const label = intent.kind === 'failover'
        ? `Failover mail to ${targetNode}`
        : intent.kind === 'failback'
          ? `Fail mail back to primary (${targetNode})`
          : `Migrate mail to ${targetNode}`;
      const started = await startTask(db, {
        kind: 'mail.migration',
        refId: runId,
        scope: 'admin',
        userId: deps.userId,
        label: toSafeText(label),
        target: {
          type: 'modal',
          modal: 'mail-migration',
          modalProps: { runId },
        },
        progressPct: 0,
        progressText: toSafeText(`${sourceNode} → ${targetNode}: preflight`),
      });
      taskId = started.id;
    } catch (err) {
      const log = deps.logger ?? { warn: console.warn, info: console.info };
      log.warn('[migration] task-center enroll failed (non-fatal):', err);
    }
  }

  // Fire-and-forget — operator polls GET /admin/mail/migrate/:runId
  void runMigrationStateMachine(runId, sourceNode, targetNode, deps, newGiB, effectiveOpts, taskId).catch(async (err) => {
    const isCancelled = err instanceof MigrationCancelledError;
    const errMsg = isCancelled
      ? `cancelled by operator at step '${err.cancelledAtStep}'`
      : (err instanceof Error ? err.message : String(err));
    await db.execute(sql`
      UPDATE mail_migration_runs
      SET state = 'failed', error_message = ${errMsg}, finished_at = now()
      WHERE id = ${runId}
    `).catch(() => { /* best-effort */ });
    if (taskId) {
      try {
        const { finish: finishTask } = await import('../tasks/service.js');
        await finishTask(db, taskId, {
          status: isCancelled ? 'cancelled' : 'failed',
          error: errMsg,
        });
      } catch { /* best-effort */ }
    }
  });

  return { runId, taskId };
}

/**
 * Operator-triggered MAIL RECOVER — used when the mail-stack is in a
 * broken state (Pod stuck Pending / CrashLoopBackOff; PVC bound on a
 * node that can't host Stalwart). Distinct from regular migration:
 *
 *   - Source node is read from the ACTUAL PVC bound-node (not from
 *     system_settings.mailActiveNode which is stale).
 *   - All "is this state safe to migrate from" preconditions are
 *     skipped: no requirement for a configured backup target, no
 *     same-source-target rejection, no fresh-snapshot step.
 *   - Stuck source pods are force-deleted EARLY (before scale-down)
 *     so waitForReplicaCount(0) doesn't hang on them.
 *
 * UI flow: detected broken state → "Recover Mail" button → target node
 * picker + type-to-confirm → POST /admin/mail/recover { targetNode }.
 *
 * After success: system_settings.mailActiveNode is updated to
 * targetNode by the same code path as migration (line ~803 in
 * runMigrationStateMachine — done is `mailDrState='healthy'` +
 * `mailActiveNode=target`).
 *
 * SAFETY: this is destructive. Any data not already in the rsync
 * standby (for FAST PATH restore) or the offsite restic repo (for
 * cold restore) is LOST. The UI MUST surface this clearly.
 */
export async function startMailRecover(
  targetNode: string,
  deps: MigrationDeps,
): Promise<{ runId: string; taskId: string | null }> {
  return startMailMigration(
    { kind: 'explicit', targetNode },
    deps,
    { recoverFromBrokenState: true },
  );
}

/**
 * Operator-triggered cancellation. Marks the run's cancel_requested
 * flag; the running state machine sees the flag at the next setStep
 * call and exits with MigrationCancelledError → the top-level catch
 * stamps the DB as 'failed' with an operator-friendly reason.
 *
 * Limitations (2026-05-27 baseline):
 *   - Cancel does NOT interrupt in-flight K8s waits. If the state
 *     machine is sitting in a 10-min waitForReplicaCount, the cancel
 *     takes effect only after that wait completes/times out. Future
 *     work: AbortSignal plumbing into the wait helpers so cancel is
 *     immediate even during waits.
 *   - Cancel does NOT roll back already-completed steps (PVC swap,
 *     scale-down). Operator must run a follow-up migration to restore
 *     placement if needed.
 *   - Cancel is idempotent: a 2nd cancel on the same run is a no-op.
 */
export async function cancelMailMigration(
  runId: string,
  deps: { db: Database; logger?: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void } },
): Promise<{ runId: string; alreadyCancelled: boolean; terminalState: string | null }> {
  const { db } = deps;
  const log = deps.logger ?? { warn: console.warn, info: console.info };

  const before = await db.execute<{ state: string; cancel_requested: boolean }>(sql`
    SELECT state, cancel_requested FROM mail_migration_runs WHERE id = ${runId}
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const beforeRows = (before as any).rows ?? (before as unknown as ReadonlyArray<{ state: string; cancel_requested: boolean }>);
  const beforeRow = beforeRows?.[0];
  if (!beforeRow) {
    throw new ApiError('MAIL_MIGRATION_NOT_FOUND', `No migration run with id ${runId}`, 404);
  }

  // Already terminal — nothing to cancel.
  if (beforeRow.state === 'done' || beforeRow.state === 'failed') {
    return { runId, alreadyCancelled: false, terminalState: beforeRow.state };
  }

  if (beforeRow.cancel_requested) {
    log.info(`[migration ${runId}] cancel already requested — no-op`);
    return { runId, alreadyCancelled: true, terminalState: null };
  }

  await db.execute(sql`
    UPDATE mail_migration_runs SET cancel_requested = true WHERE id = ${runId}
  `);
  log.warn(`[migration ${runId}] cancel requested — state machine will bail at next checkpoint`);
  return { runId, alreadyCancelled: false, terminalState: null };
}

interface PlacementRow {
  readonly mailPrimaryNode?: string | null;
  readonly mailSecondaryNode?: string | null;
  readonly mailTertiaryNode?: string | null;
}

function resolveTargetNode(intent: MigrationIntent, row: PlacementRow | undefined): string {
  switch (intent.kind) {
    case 'explicit':
      return intent.targetNode;
    case 'failover': {
      const t = row?.mailSecondaryNode ?? row?.mailTertiaryNode ?? null;
      if (!t) {
        throw new ApiError(
          'MAIL_PLACEMENT_NO_CANDIDATE',
          'No secondary or tertiary node configured — set placement policy before triggering failover',
          409,
        );
      }
      return t;
    }
    case 'failback': {
      const t = row?.mailPrimaryNode ?? null;
      if (!t) {
        throw new ApiError(
          'MAIL_PLACEMENT_NO_CANDIDATE',
          'No primary node configured — set placement policy before triggering failback',
          409,
        );
      }
      return t;
    }
  }
}

export async function getMailMigrationStatus(
  runId: string,
  deps: { db: Database },
): Promise<{
  runId: string;
  sourceNode: string;
  targetNode: string;
  state: string;
  currentStep: string | null;
  progressBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}> {
  const result = await deps.db.execute<MigrationRunRow>(sql`
    SELECT id, source_node, target_node, state, current_step, progress_bytes,
           started_at, finished_at, error_message
    FROM mail_migration_runs
    WHERE id = ${runId}
  `);
  const rows = (result as unknown as { rows: MigrationRunRow[] }).rows;
  const r = rows?.[0];
  if (!r) throw new ApiError('MAIL_MIGRATION_NOT_FOUND', 'Migration run not found', 404);
  return {
    runId: r.id,
    sourceNode: r.source_node,
    targetNode: r.target_node,
    state: r.state,
    currentStep: r.current_step ?? null,
    progressBytes: r.progress_bytes != null ? Number(r.progress_bytes) : null,
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
    finishedAt: r.finished_at != null
      ? (r.finished_at instanceof Date ? r.finished_at.toISOString() : String(r.finished_at))
      : null,
    error: r.error_message ?? null,
  };
}

// ── DR-based failover (node dead — same state machine, skip on-demand snapshot) ──

/**
 * Triggered by the DR watcher when the active node is down. Reuses
 * the standard migration state machine — the only difference is the
 * "snapshotting" step is best-effort (the source PVC may be
 * unreachable, in which case we fall back to the most recent CronJob
 * snapshot).
 *
 * This function does NOT use `startMailMigration` because:
 *   - It bypasses the cross-call concurrency guard (DR is force-majeure)
 *   - It synthesizes a run row directly (the migration row may not
 *     reflect the DB-recorded source node — node-loss DR is triggered
 *     from cluster events, not operator action)
 */
export async function triggerRestoreBasedFailover(
  targetNode: string,
  deps: { db: Database; core: CoreV1Api; apps: AppsV1Api; batch: BatchV1Api; kubeconfigPath?: string },
): Promise<void> {
  const { db } = deps;
  const log = console;

  // Snapshot sourceNode from the DB; may be stale (its node is gone)
  // but useful for the audit trail.
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
  const sourceNode = row?.mailActiveNode ?? row?.mailPrimaryNode ?? 'unknown';

  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO mail_migration_runs
      (id, source_node, target_node, state, triggered_by, current_step)
    VALUES (${runId}, ${sourceNode}, ${targetNode}, 'queued', 'dr-watcher', 'preflight')
  `);

  // Fix #3 (2026-05-25): only stamp 'failed-over' when migration
  // actually succeeded. Pre-fix code did this unconditionally so a
  // failed migration looked succeeded and dr-watcher refused to
  // retry. Live failover test on staging hit the loop: PVC delete
  // timed out → state wrongly went 'failed-over' → retry blocked.
  //
  // runMigrationStateMachine has a `failRun + return` pattern for
  // intermediate failures (deletePvcAndWait timeout, createMailPvc
  // failure, etc.) — it doesn't throw on those. So a try/catch on
  // the call alone misses the dominant failure paths (code-review
  // findings, 2026-05-25). Instead: post-call, read the
  // mail_migration_runs row state and re-throw if it landed at
  // 'failed'. dr-watcher's existing catch handler then sets
  // mailDrState='degraded' so the next tick retries.
  //
  // DR-mode flag: skip the on-demand snapshot (source unreachable).
  try {
    await runMigrationStateMachine(runId, sourceNode, targetNode, {
      ...deps,
      kubeconfigPath: deps.kubeconfigPath,
      logger: { warn: log.warn.bind(log), info: log.info.bind(log) },
    } as MigrationDeps, undefined, { skipFreshSnapshot: true });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.execute(sql`
      UPDATE mail_migration_runs
      SET state = 'failed', error_message = ${errMsg}, finished_at = now()
      WHERE id = ${runId}
    `).catch(() => { /* best-effort */ });
    throw err;
  }

  // Check the post-run state in DB to catch the `failRun + return`
  // path that intermediate failures use. Without this check, a
  // PVC-delete timeout silently returns from the state machine
  // and execution falls through to the success-path stamp below.
  const stateRows = await db.execute(sql`
    SELECT state, error_message FROM mail_migration_runs WHERE id = ${runId}
  `) as { rows?: Array<{ state: string; error_message: string | null }> };
  const stateRow = stateRows.rows?.[0];
  if (stateRow && stateRow.state === 'failed') {
    throw new Error(
      `mail migration run ${runId} ended in 'failed' state: ${stateRow.error_message ?? 'no error message recorded'}`,
    );
  }

  // Only reached on success — stamp the new active node + state.
  await db.update(systemSettings)
    .set({ mailActiveNode: targetNode, mailDrState: 'failed-over' })
    .where(eq(systemSettings.id, SETTINGS_ID));
}

// ── State machine internals ───────────────────────────────────────────────────

export interface MigrationOptions {
  /**
   * Skip step 2 (pre-migration restic backup). Used by:
   *   - DR caller — source is dead, can't snapshot anyway.
   *   - Mail backup-restore flow — pointless to backup data we're
   *     about to overwrite with an older snapshot.
   *   - Recovery flow — source is broken, can't snapshot.
   */
  readonly skipFreshSnapshot?: boolean;

  /**
   * Recovery mode — set by startMailRecover. Changes preconditions:
   *   - Source node = actual PVC bound-node (NOT system_settings.mailActiveNode
   *     which is likely stale when the system is broken).
   *   - Skip same-source-target rejection (operator legitimately wants
   *     to recover to the node system thinks is active when the pod
   *     is actually stuck elsewhere).
   *   - Skip MAIL_MIGRATION_NO_BACKUP_TARGET (backup is for safety
   *     before destructive ops; recovery is BY DEFINITION destructive
   *     of broken state, no point taking a backup).
   *   - Always implies skipFreshSnapshot=true.
   *   - Force-delete stuck source pods early (before patchReplicas)
   *     because they may already be Pending/CrashLoopBackOff and
   *     waitForReplicaCount(0) would never complete cleanly.
   *
   * NOTE: this is operator-acknowledged destructive recovery. Caller
   * MUST type-to-confirm in the UI before this flag is set.
   */
  readonly recoverFromBrokenState?: boolean;

  /**
   * Pin the restore-state init container to a specific restic snapshot
   * (short id, e.g. 'a1b2c3d4') instead of `latest`. Used by the
   * per-snapshot restore flow from /backups/mail.
   *
   * Implementation: stamped as the mail.platform/restore-snapshot-id
   * annotation on the Stalwart pod template at the swapping-pvc step,
   * then cleared at the same time as allow-restore on success so
   * subsequent failovers default to `latest` again.
   *
   * Also implies skipFreshSnapshot=true (pointless to back up data
   * we're about to overwrite with an older snapshot).
   */
  readonly restoreSnapshotId?: string;
}

/**
 * Map state-machine step keys to operator-visible progress text +
 * pct. The order matches `runMigrationStateMachine` exactly.
 */
const MIGRATION_STEP_META: Record<string, { label: string; pct: number }> = {
  preflight: { label: 'Preflight checks', pct: 5 },
  // 2026-05-27: relabelled 'Triggering fresh snapshot' → 'Taking pre-
  // migration mail backup'. This step writes a fresh restic backup to
  // the offsite mail BackupTarget — a safety net for the operator,
  // NOT a prerequisite (the actual restore path is rsync from a
  // standby node). SKIPPED when no mail BackupTarget is configured.
  snapshotting: { label: 'Taking pre-migration mail backup (offsite)', pct: 15 },
  'scaling-down': { label: 'Scaling Stalwart to 0', pct: 30 },
  'swapping-pvc': { label: 'Swapping PVC to target node', pct: 50 },
  'scaling-up': { label: 'Restoring DataStore on target node', pct: 80 },
  verifying: { label: 'Verifying RocksDB sentinel', pct: 95 },
  done: { label: 'Migration complete', pct: 100 },
};

/**
 * Sentinel thrown by setStep when the operator has POSTed
 * /admin/mail/migrate/:runId/cancel. State machine top-level catch
 * recognises this class and marks the run failed with the cancel reason
 * instead of treating it as a state-machine bug.
 */
export class MigrationCancelledError extends Error {
  readonly cancelledAtStep: string;
  constructor(step: string) {
    super(`operator cancelled migration at step '${step}'`);
    this.name = 'MigrationCancelledError';
    this.cancelledAtStep = step;
  }
}

/** Read the cancel_requested flag for a run. Returns false on read error. */
async function isCancelRequested(db: Database, runId: string): Promise<boolean> {
  try {
    const res = await db.execute<{ cancel_requested: boolean }>(sql`
      SELECT cancel_requested FROM mail_migration_runs WHERE id = ${runId}
    `);
    // drizzle's execute() shape varies by driver; tolerate both.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (res as any).rows ?? (res as unknown as ReadonlyArray<{ cancel_requested: boolean }>);
    const first = rows?.[0];
    return first?.cancel_requested === true;
  } catch {
    return false;
  }
}

async function setStep(
  db: Database,
  runId: string,
  step: string,
  state = 'running',
  taskId?: string | null,
): Promise<void> {
  // Cancel checkpoint — every step transition is a natural place to bail.
  // The state machine never moves past a setStep call without checking,
  // so an operator's cancel takes effect within ~1 step (not 10-20 min).
  if (await isCancelRequested(db, runId)) {
    throw new MigrationCancelledError(step);
  }

  await db.execute(sql`
    UPDATE mail_migration_runs
    SET current_step = ${step}, state = ${state}
    WHERE id = ${runId}
  `);

  // Task-center progress (2026-05-16): every state-machine step also
  // writes the chip's progress so the operator sees live state in the
  // top-bar chip + on the inline MailMigrationProgressModal which
  // polls the same data.
  if (taskId) {
    const meta = MIGRATION_STEP_META[step] ?? { label: step, pct: null };
    try {
      const { progress: progressTask } = await import('../tasks/service.js');
      const { toSafeText } = await import('@k8s-hosting/api-contracts');
      await progressTask(db, taskId, {
        pct: meta.pct,
        text: toSafeText(meta.label),
      });
    } catch {
      /* best-effort — never block the migration on a task-center write */
    }
  }
}

async function failRun(
  db: Database,
  runId: string,
  message: string,
  taskId?: string | null,
): Promise<void> {
  await db.execute(sql`
    UPDATE mail_migration_runs
    SET state = 'failed', error_message = ${message}, finished_at = now()
    WHERE id = ${runId}
  `);
  if (taskId) {
    try {
      const { finish: finishTask } = await import('../tasks/service.js');
      await finishTask(db, taskId, { status: 'failed', error: message });
    } catch {
      /* best-effort */
    }
  }
}

async function runMigrationStateMachine(
  runId: string,
  _sourceNode: string,
  targetNode: string,
  deps: MigrationDeps,
  newGiB?: number,
  opts: MigrationOptions = {},
  taskId?: string | null,
): Promise<void> {
  const { db, core, apps, kubeconfigPath } = deps;
  const log = deps.logger ?? { warn: console.warn, info: console.info };

  // Step 1: Preflight — validate target node is schedulable + has disk
  //         AND has a viable restore path BEFORE we delete the source PVC.
  await setStep(db, runId, 'preflight', 'running', taskId);
  const usedBytes = await getMailPvcRequestedBytes(core);
  const requiredBytes = Math.ceil(usedBytes * DISK_HEADROOM_RATIO);
  log.info(`[migration ${runId}] preflight: PVC requested=${usedBytes} bytes, target headroom=${requiredBytes}`);

  // CRITICAL preflight (2026-05-27): before the destructive PVC swap,
  // verify the target node has a viable RESTORE PATH. Without this
  // check, an operator can move mail to a node that has neither FAST
  // PATH standby data NOR working restic reachability — Stalwart's
  // restore-state init container then loops on restic retries until
  // the per-deployment 10-min waitForReplicaCount timeout fires (×2
  // deployments = 20 min). Operator sees 20 min of 'running' with no
  // diagnostic and no cancel.
  //
  // We accept the migration only if AT LEAST ONE of these holds:
  //   (a) target node is labelled platform.phoenix-host.net/mail-standby=true
  //       AND has a fresh .standby-complete sentinel (FAST PATH ready)
  //   (b) backup-rclone-shim Service has ≥1 Endpoint reachable from
  //       the target node (restic fallback will work)
  //
  // (a) is checked via node labels + DaemonSet readiness — if the
  // standby DaemonSet pod on target is Ready, the standby data has
  // been staged (or is being staged on first run).
  // (b) is checked via Endpoint existence — we don't run a Pod on
  // target to TCP-probe the shim (would add ~30s to every migration),
  // but Endpoint count is the operator's leading indicator.
  try {
    const preflight = await validateTargetRestoreReadiness(core, targetNode, log);
    if (!preflight.ok) {
      // Recovery mode: operator has already type-to-confirmed an
      // acknowledged-destructive action. The preflight stays
      // informational — log the warning but proceed. The operator
      // sees the warning in the migration progress modal and can
      // cancel if needed. For regular migrations the preflight
      // remains a hard block.
      if (opts.recoverFromBrokenState) {
        log.warn(`[migration ${runId}] recovery preflight WARNING (operator-acknowledged): ${preflight.reason}`);
      } else {
        await failRun(db, runId, preflight.reason, taskId);
        return;
      }
    } else {
      log.info(`[migration ${runId}] preflight passed: ${preflight.path}`);
    }
  } catch (err) {
    await failRun(
      db, runId,
      `preflight check failed unexpectedly — aborting before destructive PVC swap: ${err instanceof Error ? err.message : String(err)}`,
      taskId,
    );
    return;
  }

  // Step 2: Take pre-migration mail backup (offsite restic backup).
  //
  // SAFETY NET, NOT A PREREQUISITE. The actual migration restore path
  // is rsync from a standby-labelled node — restic is only the
  // cold-DR fallback. This step writes a fresh restic snapshot so the
  // operator has a known-good restore point if the migration corrupts
  // data. We SKIP it when:
  //   (a) opts.skipFreshSnapshot=true (DR caller — source is dead, can't
  //       snapshot anyway).
  //   (b) No mail BackupTarget is configured — running the snapshot Job
  //       would just fail with missing RESTIC_REPOSITORY. Pre-fix this
  //       was happening silently for ~5 min until the wait timed out.
  //
  // The snapshot Pod inherits node affinity from the CronJob template
  // (preferred-during-scheduling pod-affinity to stalwart-mail), so it
  // runs on the ACTIVE node where the data actually lives.
  if (!opts.skipFreshSnapshot) {
    const hasMailBackupTarget = await checkMailBackupTargetConfigured(db);
    if (!hasMailBackupTarget) {
      log.info(
        `[migration ${runId}] no mail BackupTarget configured — skipping pre-migration backup. ` +
        `Migration restore path (rsync from standby) does not need restic; configure a mail ` +
        `BackupTarget at /backups/mail if you want a pre-migration safety net.`,
      );
    } else {
      await setStep(db, runId, 'snapshotting', 'running', taskId);
      try {
        await triggerMailSnapshot({ kubeconfigPath, db });
        // Wait until the snapshot completes. The snapshot CronJob runs
        // every 2 minutes; an on-demand trigger usually completes in
        // 20-60s for small DataStores. We poll for up to 5 min.
        await waitForFreshSnapshot(deps, 300);
      } catch (snapErr) {
        log.warn('[migration] fresh snapshot failed; will proceed with the latest CronJob snapshot:', snapErr);
      }
    }
  }

  // Step 3: Scale Stalwart to 0 (releases the source PVC mount).
  //
  // Recovery mode: stuck pods (Pending / CrashLoopBackOff on dead or
  // unreachable nodes) may never release the PVC mount cleanly even
  // after replicas=0 is patched. Pre-emptively force-delete them so
  // waitForReplicaCount(0) doesn't hang for the full 90s timeout.
  //
  // Ordering: forceDeleteStuckPodsOnDeadNodes' inner guard only acts on
  // pods that ALREADY have deletionTimestamp set (in Terminating). So we
  // patch replicas=0 FIRST (which adds deletionTimestamp via the
  // Deployment controller), THEN force-delete the ones that won't die
  // naturally. Calling force-delete before scale-down would be a no-op.
  await setStep(db, runId, 'scaling-down', 'running', taskId);
  await patchDeploymentReplicas(apps, 0);
  if (opts.recoverFromBrokenState) {
    try {
      await forceDeleteStuckPodsOnDeadNodes(core, MAIL_PVC_NAME);
      log.info(`[migration ${runId}] recovery: force-deleted any stuck Terminating pods referencing ${MAIL_PVC_NAME}`);
    } catch (err) {
      log.warn(`[migration ${runId}] recovery: force-delete pass failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await waitForReplicaCount(apps, 0, 90);

  // Step 4: Swap the PVC binding to the target node + signal restore-on-start.
  //
  // Sub-steps:
  //   4a. Delete the source PVC (releases the local-path PV bound to
  //       source node — local-path leaves data on disk but the PV is
  //       gone; the orphan is GC'd by the provisioner later).
  //   4b. Re-create the PVC with the SAME name plus
  //       `volume.kubernetes.io/selected-node: <targetNode>` so the
  //       provisioner creates a fresh PV on the target node.
  //   4c. SSA-patch the Deployment's `template.spec.affinity` to pin
  //       the pod to targetNode + set the `mail.platform/allow-restore`
  //       annotation that the `restore-state` initContainer reads.
  //
  // The PVC name never changes → no Flux/platform-api ownership war.
  // Affinity is NOT declared in the manifest → Flux's reconcile ignores it.
  await setStep(db, runId, 'swapping-pvc', 'running', taskId);

  const pvcSizeGiB = newGiB ?? Math.ceil(await getMailPvcRequestedBytes(core) / (1024 ** 3));

  // **Phase K live-test (2026-05-15) fix:** clear completed snapshot
  // CronJob pods that still reference the PVC, otherwise pvc-protection
  // deadlocks the delete. K8s holds the PVC in Terminating while ANY
  // pod references it — including Completed pods that haven't hit
  // ttlSecondsAfterFinished yet. The snapshot CronJob runs every 2 min
  // and leaves 5-10 Completed pods stacked at any time.
  try {
    await suspendSnapshotCronJobAndDeleteCompletedPods(deps);
  } catch (err) {
    log.warn('[migration] snapshot CronJob cleanup non-fatal — proceeding:', err);
  }

  try {
    await deletePvcAndWait(core, MAIL_PVC_NAME, 120);
  } catch (err) {
    await failRun(db, runId, `failed to delete source PVC: ${(err as Error).message}`, taskId);
    // Re-enable the snapshot CronJob even on failure so backups resume.
    await resumeSnapshotCronJob(deps).catch(() => { /* best-effort */ });
    return;
  }

  try {
    await createMailPvc(core, targetNode, pvcSizeGiB);
  } catch (err) {
    // Resume snapshot CronJob before bailing — was suspended at step 4a.
    await resumeSnapshotCronJob(deps).catch(() => { /* best-effort */ });
    await failRun(db, runId, `failed to recreate PVC on target node: ${(err as Error).message}`, taskId);
    return;
  }

  try {
    await applyDeploymentAffinity(
      apps,
      targetNode,
      /* allowRestore */ true,
      opts.restoreSnapshotId ?? null,
    );
  } catch (err) {
    await resumeSnapshotCronJob(deps).catch(() => { /* best-effort */ });
    await failRun(db, runId, `failed to apply target-node affinity: ${(err as Error).message}`, taskId);
    return;
  }

  // Step 5: Scale Stalwart back to 1 — pod schedules on target node,
  // binds the new PVC, the restore-state initContainer notices the
  // empty DataStore + allow-restore annotation + restic repo and
  // re-imports the latest snapshot.
  //
  // Longer timeout than usual because the restore can take 1-5 min
  // depending on DataStore size and BackupStore latency.
  await setStep(db, runId, 'scaling-up', 'running', taskId);
  await patchDeploymentReplicas(apps, 1);
  await waitForReplicaCount(apps, 1, 600);

  // Step 6: Verify the restore actually RESTORED tenant data — not just
  // that Stalwart opened a (possibly empty) DataStore.
  //
  // PRE-FIX (silent data-loss bug, root-caused 2026-05-27): we only
  // checked /var/lib/stalwart/data/CURRENT — the RocksDB MANIFEST file
  // RocksDB creates on first open of ANY data dir, including an empty
  // one. An init-container fresh-start (restic failed → silent
  // exit 0) passed this check. The 2026-05-25 19:23 staging E2E lost
  // 2 tenant Domains + their mailboxes via this exact path; migration
  // state machine happily marked state=done.
  //
  // POST-FIX content verification (3 layers):
  //   a. .fresh-started-at sentinel MUST NOT exist (proves a real
  //      restore ran, not the fresh-start fallback).
  //   b. Every email_domains.stalwart_domain_id in the DB MUST resolve
  //      to a Stalwart Domain entry via x:Domain/get. A missing id
  //      means Stalwart lost the tenant Domain.
  //   c. Stalwart's individual-principal count MUST be >= the DB
  //      mailbox count. Less = mailboxes lost.
  //
  // On any failure: failRun with a specific diagnostic AND set
  // mailDrState='degraded' (not 'healthy') so the operator sees the
  // problem in the admin UI rather than mistakenly trusting the
  // migration succeeded.
  await setStep(db, runId, 'verifying', 'running', taskId);
  const podName = await findStalwartPod(core);
  if (podName) {
    // Recovery mode: ONLY check that a real restore ran (no
    // .fresh-started-at sentinel). Don't check tenant Domain count
    // or principal count — those reflect the pre-existing drift the
    // operator is recovering FROM, not damage caused by the recovery.
    // Drift is independently surfaced via /email/drift and the
    // mail-drift module's notifications.
    //
    // Caught 2026-05-27 E2E on staging: the recovery migration
    // successfully restored Stalwart data, but the verifier flagged
    // 3 pre-existing missing tenant Domains as "restore was
    // incomplete — tenant mail data lost." That's misleading — the
    // Domains were already gone before recovery (the WHOLE REASON
    // we're recovering). Strict-verify in recover mode also blocked
    // the resumeSnapshotCronJob cleanup at step 7b, leaving the
    // snapshot pipeline suspended for hours.
    const verify = opts.recoverFromBrokenState
      ? await verifyRecoveryMinimal(podName, kubeconfigPath, log)
      : await verifyRestoreContent(db, podName, kubeconfigPath, log);
    if (!verify.ok) {
      // Mark mailDrState=degraded so the operator UI surfaces the
      // problem; the migration's 'failed' state alone is too easy to
      // miss.
      await db.update(systemSettings)
        .set({ mailDrState: 'degraded' })
        .where(eq(systemSettings.id, SETTINGS_ID))
        .catch(() => { /* best-effort — failRun below is the source of truth */ });
      // Resume the snapshot CronJob BEFORE failing so the operator
      // doesn't end up with both a failed migration AND a stuck
      // snapshot pipeline. Caught 2026-05-27 — see verify comment.
      try { await resumeSnapshotCronJob(deps); } catch { /* best-effort */ }
      await failRun(
        db, runId,
        `restore content verification failed: ${verify.reason}`,
        taskId,
      );
      return;
    }
  }

  // Step 7: Clear the allow-restore annotation so subsequent pod
  // restarts don't re-trigger the restore-state init. (The init also
  // short-circuits on existing CURRENT, so this is belt-and-suspenders.)
  try {
    await clearAllowRestoreAnnotation(apps);
  } catch (annotErr) {
    log.warn('[migration] failed to clear allow-restore annotation (non-fatal):', annotErr);
  }

  // Step 7b: Resume the snapshot CronJob suspended at swapping-pvc.
  try {
    await resumeSnapshotCronJob(deps);
  } catch (err) {
    log.warn('[migration] failed to resume snapshot CronJob (non-fatal — operator should re-enable manually):', err);
  }

  // Step 8: Update DB → success
  await db.update(systemSettings)
    .set({ mailActiveNode: targetNode, mailDrState: 'healthy' })
    .where(eq(systemSettings.id, SETTINGS_ID));

  await db.execute(sql`
    UPDATE mail_migration_runs
    SET state = 'done', current_step = 'complete', finished_at = now()
    WHERE id = ${runId}
  `);

  // Task-center finalisation (success path).
  if (taskId) {
    try {
      const { finish: finishTask } = await import('../tasks/service.js');
      const { toSafeText } = await import('@k8s-hosting/api-contracts');
      await finishTask(db, taskId, {
        status: 'succeeded',
        text: toSafeText(`Mail relocated to ${targetNode}`),
      });
    } catch (err) {
      log.warn('[migration] task-center finalise (success) failed (non-fatal):', err);
    }
  }

  log.info(`[migration] run ${runId}: migration to ${targetNode} complete`);
}

// ── PVC helpers ───────────────────────────────────────────────────────────────

/**
 * Read the actual node a PVC is bound to via its selected-node annotation.
 * Used by recovery flow to find the real source node when system_settings.
 * mailActiveNode is stale.
 */
async function readActualPvcBoundNode(core: CoreV1Api): Promise<string | null> {
  try {
    const pvc = await core.readNamespacedPersistentVolumeClaim({
      name: MAIL_PVC_NAME,
      namespace: MAIL_NAMESPACE,
    }) as { metadata?: { annotations?: Record<string, string> }; spec?: { volumeName?: string } };
    const selectedNode = pvc.metadata?.annotations?.['volume.kubernetes.io/selected-node'];
    if (selectedNode) return selectedNode;
    // Older PVCs without the annotation — fall back to reading the bound PV's nodeAffinity.
    const pvName = pvc.spec?.volumeName;
    if (!pvName) return null;
    const pv = await core.readPersistentVolume({ name: pvName }) as {
      spec?: {
        nodeAffinity?: {
          required?: {
            nodeSelectorTerms?: ReadonlyArray<{
              matchExpressions?: ReadonlyArray<{ key?: string; values?: string[] }>;
            }>;
          };
        };
      };
    };
    // Scan ALL terms × ALL matchExpressions for key === 'kubernetes.io/hostname'.
    // Local-path provisioner always uses that key, but a Longhorn-backed PV
    // would have topology.kubernetes.io/zone in matchExpressions[0] and the
    // hostname key elsewhere — pre-fix readers took [0][0] blindly and would
    // have returned a zone string as a node name (caught by code review).
    const terms = pv.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? [];
    for (const term of terms) {
      const exprs = term.matchExpressions ?? [];
      for (const expr of exprs) {
        if (expr.key === 'kubernetes.io/hostname' && expr.values && expr.values.length > 0) {
          return expr.values[0];
        }
      }
    }
    return null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Read the current PVC's requested storage size in bytes.
 */
async function getMailPvcRequestedBytes(core: CoreV1Api): Promise<number> {
  try {
    const pvc = await core.readNamespacedPersistentVolumeClaim({
      name: MAIL_PVC_NAME,
      namespace: MAIL_NAMESPACE,
    }) as { spec?: { resources?: { requests?: { storage?: string } } } };
    const storageStr = pvc.spec?.resources?.requests?.storage ?? '20Gi';
    return parseQuantity(storageStr);
  } catch (err) {
    if (isNotFound(err)) {
      // PVC missing (rare — only if a previous migration aborted between
      // delete + create). Fall back to manifest default.
      return parseQuantity('20Gi');
    }
    throw err;
  }
}

/**
 * Delete the named PVC and wait until the apiserver reports it gone.
 *
 * local-path PVCs are tied to a finalizer that runs the provisioner's
 * cleanup pod. Deletion blocks until the cleanup completes; we wait up
 * to `timeoutSeconds` for the apiserver to surface 404.
 *
 * Fix #2 (2026-05-25, A4 destructive test): when the source node's
 * kubelet is dead, pods on it sit Terminating forever (kubelet never
 * confirms delete). The PVC's `pvc-protection` finalizer keeps the
 * PVC alive because at least one mounted pod still exists. Detect
 * this case (no progress at 30s with pods still Terminating on a
 * NotReady node) and force-delete the stuck pods, which releases
 * the finalizer and lets normal PVC deletion proceed.
 */
async function deletePvcAndWait(core: CoreV1Api, name: string, timeoutSeconds: number): Promise<void> {
  try {
    await core.deleteNamespacedPersistentVolumeClaim({ name, namespace: MAIL_NAMESPACE });
  } catch (err) {
    if (isNotFound(err)) return; // already gone
    throw err;
  }
  const startMs = Date.now();
  const deadline = startMs + timeoutSeconds * 1000;
  let forceDeleteTried = false;
  while (Date.now() < deadline) {
    try {
      await core.readNamespacedPersistentVolumeClaim({ name, namespace: MAIL_NAMESPACE });
      // After 30s of waiting, escalate: enumerate pods still mounting
      // the PVC, force-delete any whose node is NotReady (kubelet won't
      // confirm graceful termination, finalizer blocks PVC forever).
      if (!forceDeleteTried && (Date.now() - startMs) >= 30_000) {
        forceDeleteTried = true;
        await forceDeleteStuckPodsOnDeadNodes(core, name);
      }
      await sleep(2000);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }
  throw new ApiError(
    'MAIL_MIGRATION_PVC_DELETE_TIMEOUT',
    `PVC ${MAIL_NAMESPACE}/${name} still exists after ${timeoutSeconds}s — finalizer may be stuck. Inspect with kubectl describe.`,
    500,
  );
}

/**
 * Force-delete any pod still mounting the given PVC whose host node is
 * NotReady. The kubelet on a dead node never confirms graceful
 * termination, so pvc-protection blocks PVC deletion indefinitely.
 *
 * Best-effort: errors are logged and swallowed (the outer wait loop
 * surfaces a clean timeout if this didn't resolve it).
 */
async function forceDeleteStuckPodsOnDeadNodes(
  core: CoreV1Api,
  pvcName: string,
): Promise<void> {
  // List all pods in mail ns. Filter to those volumes[] contains our PVC.
  type PodShape = {
    metadata?: { name?: string; deletionTimestamp?: string };
    spec?: {
      nodeName?: string;
      volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }>;
    };
  };
  const podList = await core.listNamespacedPod({ namespace: MAIL_NAMESPACE }) as { items?: PodShape[] };
  const pods = podList.items ?? [];
  for (const pod of pods) {
    const podName = pod.metadata?.name;
    const nodeName = pod.spec?.nodeName;
    const isTerminating = !!pod.metadata?.deletionTimestamp;
    const mountsPvc = (pod.spec?.volumes ?? []).some(
      (v) => v.persistentVolumeClaim?.claimName === pvcName,
    );
    // `!isTerminating` is belt-and-braces: the call sequence in
    // runMigrationStateMachine is patchDeploymentReplicas(apps, 0) +
    // waitForReplicaCount(apps, 0, 90) BEFORE deletePvcAndWait, so
    // every pod listed here is either gone or Terminating already.
    // The guard protects against a hypothetical future call-site that
    // invokes deletePvcAndWait without first scaling Deployments down.
    if (!podName || !nodeName || !isTerminating || !mountsPvc) continue;

    // Check node Ready status. If True, leave the pod alone — kubelet
    // is healthy and will eventually finalize the delete.
    let nodeReady = true;
    try {
      const node = await core.readNode({ name: nodeName }) as {
        status?: { conditions?: Array<{ type: string; status: string }> };
      };
      const readyCond = node.status?.conditions?.find((c) => c.type === 'Ready');
      // Treat 'False' AND 'Unknown' as not-ready (kubelet not reporting).
      nodeReady = readyCond?.status === 'True';
    } catch {
      nodeReady = false;
    }
    if (nodeReady) continue;

    // Force-delete: grace 0 + propagation Background. Releases the PVC
    // finalizer immediately.
    try {
      await core.deleteNamespacedPod({
        name: podName,
        namespace: MAIL_NAMESPACE,
        gracePeriodSeconds: 0,
        propagationPolicy: 'Background',
      } as unknown as Parameters<typeof core.deleteNamespacedPod>[0]);
    } catch {
      // best-effort; the outer loop logs the timeout if this didn't help
    }
  }
}

/**
 * Create the Stalwart PVC with a `selected-node` annotation so the
 * local-path provisioner creates the PV on the target node.
 */
async function createMailPvc(core: CoreV1Api, targetNode: string, sizeGiB: number): Promise<void> {
  // Mail-DataStore PVC recreate during migration. The data inside is
  // captured by the mail-snapshot bundle component (restic, 2-min
  // interval) — this `createNamespacedPersistentVolumeClaim` only
  // recreates the empty volume; the `restore-state` initContainer
  // re-imports the data on the next pod start.
  // backup-coverage: captured-by:mail-snapshot
  await core.createNamespacedPersistentVolumeClaim({
    namespace: MAIL_NAMESPACE,
    body: {
      metadata: {
        name: MAIL_PVC_NAME,
        namespace: MAIL_NAMESPACE,
        annotations: {
          'volume.kubernetes.io/selected-node': targetNode,
        },
        labels: {
          app: 'stalwart-mail',
          'app.kubernetes.io/part-of': 'hosting-platform',
          'app.kubernetes.io/component': 'mail-server',
        },
      },
      spec: {
        storageClassName: 'local-path',
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: `${sizeGiB}Gi` } },
      },
    } as unknown as Parameters<typeof core.createNamespacedPersistentVolumeClaim>[0]['body'],
  });
}

// ── Deployment helpers ────────────────────────────────────────────────────────

/**
 * Patch the Stalwart Deployment with:
 *   - `template.spec.nodeSelector[kubernetes.io/hostname] = targetNode`
 *     (hostname pinning — see "Why nodeSelector not nodeAffinity" below)
 *   - `metadata.annotations[mail.platform/allow-restore] = "true"` (when
 *     `allowRestore` is true; the downward-API mount surfaces this to
 *     the `restore-state` initContainer).
 *
 * **Why nodeSelector, not nodeAffinity** (Phase K live-test, 2026-05-15):
 *
 * The `k8s/components/system-node-affinity/affinity-patch-stalwart.yaml`
 * component sets `nodeAffinity` to allow role: [server, worker]. Any
 * patch we send to `spec.template.spec.affinity` collides with that
 * component's strategic-merge — the apiserver applies a merge-by-key
 * on `matchExpressions[].key`, and Flux's next reconcile re-applies
 * the component's affinity, dropping our hostname expression.
 *
 * `nodeSelector` is a flat `map[string]string` with no merge-key
 * semantics. We OWN our key (`kubernetes.io/hostname`); Flux doesn't
 * declare it; the apiserver merges the two flat maps independently.
 * BOTH the affinity (role: server,worker) AND our nodeSelector
 * (hostname: targetNode) must match for the pod to schedule — the
 * intersection is exactly the target node.
 *
 * If a future Flux change starts setting `nodeSelector` too, we'd
 * have the same collision again — but Stalwart's manifest doesn't
 * use `nodeSelector` today and there's no reason for an operator to
 * pin Stalwart globally via that field, so this is stable.
 */
/**
 * Pin a Deployment's pod template to `targetNode` via nodeSelector.
 * Optionally stamps the `mail.platform/allow-restore` annotation —
 * the caller is responsible for passing `allowRestore=false` for
 * Bulwark (it has no restore-state init container today, so the
 * annotation would have no effect; A2 will give it one).
 *
 * Idempotent — patches are merge-patch semantics, so applying the
 * same selector twice is a no-op.
 */
async function applyDeploymentAffinityOne(
  apps: AppsV1Api,
  name: string,
  targetNode: string,
  allowRestore: boolean,
  restoreSnapshotId: string | null,
): Promise<void> {
  // Fix #4 (2026-05-25): allow-restore annotation MUST live in
  // spec.template.metadata.annotations (pod template) — NOT
  // metadata.annotations (Deployment object). The restore-state init
  // container reads /podinfo via downwardAPI which mounts
  // pod.metadata.annotations, which inherits from the pod TEMPLATE.
  // Pre-existing bug discovered during A4 destructive test on
  // staging: the original code stamped the Deployment object's
  // annotations, which never propagated to the pod, so the init
  // container always saw allow-restore=false and fresh-started.
  //
  // restore-snapshot-id (2026-05-27) follows the same rule for the
  // same reason — pod-template annotations only.
  const annotations: Record<string, string> = {};
  if (allowRestore) annotations[ALLOW_RESTORE_ANNOTATION] = 'true';
  if (restoreSnapshotId) annotations[RESTORE_SNAPSHOT_ID_ANNOTATION] = restoreSnapshotId;
  const body = {
    spec: {
      template: {
        metadata: Object.keys(annotations).length > 0 ? { annotations } : undefined,
        spec: {
          nodeSelector: {
            'kubernetes.io/hostname': targetNode,
          },
        },
      },
    },
  };
  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name,
      body,
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    MIGRATION_AFFINITY_PATCH,
  );
}

/**
 * Apply node-pin to every Deployment in MAIL_STACK_DEPLOYMENTS in
 * sequence. Stalwart and Bulwark always move together. A failure on
 * the second Deployment leaves the first patched — recoverable on
 * the next migration tick (the patches are idempotent).
 *
 * `allowRestore` and `restoreSnapshotId` only stamp annotations on
 * Stalwart (no meaning for Bulwark today; A2 will give Bulwark its own
 * restore path that consumes the same annotations).
 */
export async function applyDeploymentAffinity(
  apps: AppsV1Api,
  targetNode: string,
  allowRestore: boolean,
  restoreSnapshotId: string | null = null,
): Promise<void> {
  for (const name of MAIL_STACK_DEPLOYMENTS) {
    const stampAllow = allowRestore && name === DEPLOYMENT_NAME;
    const stampId = name === DEPLOYMENT_NAME ? restoreSnapshotId : null;
    await applyDeploymentAffinityOne(apps, name, targetNode, stampAllow, stampId);
  }
}

/**
 * Suspend the `stalwart-snapshot` CronJob and force-delete all of its
 * existing Completed pods.
 *
 * Why both:
 *   - Suspend prevents the next CronJob fire from creating a new pod
 *     mid-migration (which would re-bind the source PVC and block delete).
 *   - Force-delete clears the backlog of Completed pods that K8s keeps
 *     around for ttlSecondsAfterFinished (typically 5-10 such pods at any
 *     time given the 2-min snapshot cadence). Each Completed pod holds a
 *     PVC reference and blocks pvc-protection from finalising the delete.
 *
 * Best-effort — if the CronJob doesn't exist, we silently no-op. If
 * suspend fails, we still try to delete the pods. The migration's
 * deletePvcAndWait has its own 120s timeout that will surface the issue
 * as MAIL_MIGRATION_PVC_DELETE_TIMEOUT if pods aren't gone in time.
 */
async function suspendSnapshotCronJobAndDeleteCompletedPods(deps: MigrationDeps): Promise<void> {
  const { core, batch } = deps;

  // Suspend the CronJob.
  try {
    await batch.patchNamespacedCronJob(
      {
        namespace: MAIL_NAMESPACE,
        name: 'stalwart-snapshot',
        body: { spec: { suspend: true } },
      } as unknown as Parameters<typeof batch.patchNamespacedCronJob>[0],
      MIGRATION_DEPLOYMENT_PATCH,
    );
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // CronJob absent — no backlog to clear either.
    return;
  }

  // Find + force-delete all pods labelled as snapshot jobs.
  const pods = await core.listNamespacedPod({
    namespace: MAIL_NAMESPACE,
    labelSelector: 'app.kubernetes.io/component=stalwart-snapshot',
  }) as { items?: Array<{ metadata?: { name?: string } }> };
  for (const p of pods.items ?? []) {
    const podName = p.metadata?.name;
    if (!podName) continue;
    try {
      await core.deleteNamespacedPod({
        namespace: MAIL_NAMESPACE,
        name: podName,
        gracePeriodSeconds: 0,
      } as unknown as Parameters<typeof core.deleteNamespacedPod>[0]);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

/**
 * Re-enable the `stalwart-snapshot` CronJob after migration completes
 * (success or failure path). Idempotent.
 */
async function resumeSnapshotCronJob(deps: MigrationDeps): Promise<void> {
  const { batch } = deps;
  try {
    await batch.patchNamespacedCronJob(
      {
        namespace: MAIL_NAMESPACE,
        name: 'stalwart-snapshot',
        body: { spec: { suspend: false } },
      } as unknown as Parameters<typeof batch.patchNamespacedCronJob>[0],
      MIGRATION_DEPLOYMENT_PATCH,
    );
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/**
 * Remove the `mail.platform/allow-restore` AND
 * `mail.platform/restore-snapshot-id` annotations after a successful
 * migration so subsequent pod restarts don't trigger the restore-state
 * initContainer's restic path with stale parameters.
 *
 * Uses merge-patch with `null` to delete the keys (RFC 7396 semantics).
 * Stalwart-only — Bulwark has no restore-state init container today.
 */
async function clearAllowRestoreAnnotation(apps: AppsV1Api): Promise<void> {
  // Fix #4: clear from spec.template.metadata.annotations (pod
  // template) to match the location applyDeploymentAffinityOne now
  // writes to. Belt-and-braces: also clear from metadata.annotations
  // (Deployment) so legacy clusters that have the pre-fix annotation
  // sitting there get cleaned up too.
  const nullAnnotations = {
    [ALLOW_RESTORE_ANNOTATION]: null,
    [RESTORE_SNAPSHOT_ID_ANNOTATION]: null,
  };
  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name: DEPLOYMENT_NAME,
      body: {
        metadata: {
          annotations: nullAnnotations,
        },
        spec: {
          template: {
            metadata: {
              annotations: nullAnnotations,
            },
          },
        },
      },
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    MERGE_PATCH,
  );
}

/**
 * Scale a single Deployment in the mail namespace.
 * Used by the wrapper below to fan out across MAIL_STACK_DEPLOYMENTS.
 */
async function patchDeploymentReplicasOne(
  apps: AppsV1Api,
  name: string,
  replicas: number,
): Promise<void> {
  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name,
      body: { spec: { replicas } },
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    MIGRATION_DEPLOYMENT_PATCH,
  );
}

/**
 * A4 (2026-05-25): scale EVERY Deployment in MAIL_STACK_DEPLOYMENTS
 * together. Migration moves the whole mail stack atomically — scaling
 * only Stalwart while leaving Bulwark trying to mount the deleted
 * legacy PVC would CrashLoopBackOff Bulwark for the entire migration
 * window.
 */
async function patchDeploymentReplicas(apps: AppsV1Api, replicas: number): Promise<void> {
  for (const name of MAIL_STACK_DEPLOYMENTS) {
    await patchDeploymentReplicasOne(apps, name, replicas);
  }
}

async function waitForReplicaCount(apps: AppsV1Api, target: number, timeoutSeconds: number): Promise<void> {
  // Wait for EACH mail-stack Deployment to reach `target` ready replicas.
  // Sequential because the rollout-wait helper polls each in turn — total
  // wait time is bounded by `timeoutSeconds` per Deployment.
  for (const name of MAIL_STACK_DEPLOYMENTS) {
    await waitForStalwartReplicaCount(apps, target, { timeoutSeconds, deploymentName: name });
  }
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

/**
 * Poll the snapshot CronJob's lastSuccessfulTime until it advances past
 * the migration's start time, indicating our on-demand trigger produced
 * a fresh snapshot. Falls through silently after `timeoutSeconds` — the
 * migration will still proceed using the latest available snapshot.
 */
async function waitForFreshSnapshot(deps: MigrationDeps, timeoutSeconds: number): Promise<void> {
  const { batch } = deps;
  const startTs = Date.now();
  const deadline = startTs + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const cron = await batch.readNamespacedCronJob({
        name: 'stalwart-mail-snapshot',
        namespace: MAIL_NAMESPACE,
      }) as { status?: { lastSuccessfulTime?: string } };
      const lastStr = cron.status?.lastSuccessfulTime;
      if (lastStr) {
        const last = Date.parse(lastStr);
        if (Number.isFinite(last) && last >= startTs) return;
      }
    } catch {
      /* swallow — the wait is best-effort */
    }
    await sleep(5000);
  }
}

// ── Pod inspection ────────────────────────────────────────────────────────────

async function findStalwartPod(core: CoreV1Api): Promise<string | null> {
  try {
    const pods = await core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: 'app=stalwart-mail',
    }) as { items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> };
    const items = pods.items ?? [];
    return items.find((p) => p.status?.phase === 'Running')?.metadata?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Content-based post-restore verification. Replaces the legacy
 * verifySentinelExists which only checked that RocksDB's CURRENT file
 * was on-disk (true for ANY data dir, including a fresh-started one).
 *
 * Returns ok:true only when all three checks pass — see migration step
 * 6 header for the full reasoning. The returned `reason` text is
 * surfaced verbatim in the mail_migration_runs.error_message column
 * and the admin task-center, so write it operator-friendly.
 */
/**
 * Recovery-mode verifier — minimum viable check. Only confirms a real
 * restore ran (no .fresh-started-at sentinel). Does NOT cross-check
 * tenant Domain or principal counts against the platform DB because
 * recovery is operator-acknowledged restore from a broken state — the
 * platform DB likely references entities Stalwart lost before recovery
 * even started. That drift is independently surfaced via /email/drift,
 * not double-flagged here.
 */
async function verifyRecoveryMinimal(
  podName: string,
  kubeconfigPath: string | undefined,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const freshStarted = await podHasFile(podName, '/var/lib/stalwart/data/.fresh-started-at', kubeconfigPath);
    if (freshStarted) {
      const reason = await readPodFile(podName, '/var/lib/stalwart/data/.fresh-started-at', kubeconfigPath);
      return {
        ok: false,
        reason: `Stalwart fresh-started instead of restoring (.fresh-started-at sentinel found: ${reason.trim().slice(0, 160) || 'reason unrecorded'}). Restic restore or FAST PATH copy silently failed — no data was restored. Investigate init container logs + backup-rclone-shim reachability from the target node.`,
      };
    }
    log.info('[recovery] verify minimal: .fresh-started-at absent → restore ran. Drift checks skipped in recovery mode (see /email/drift).');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `failed to probe Stalwart pod for fresh-start sentinel: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function verifyRestoreContent(
  db: Database,
  podName: string,
  kubeconfigPath: string | undefined,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // (a) Reject if the init container's fresh-start sentinel exists —
  // proves restic restore (or FAST PATH copy) failed silently.
  try {
    const freshStarted = await podHasFile(podName, '/var/lib/stalwart/data/.fresh-started-at', kubeconfigPath);
    if (freshStarted) {
      const reason = await readPodFile(podName, '/var/lib/stalwart/data/.fresh-started-at', kubeconfigPath);
      return {
        ok: false,
        reason: `Stalwart fresh-started instead of restoring (.fresh-started-at sentinel found: ${reason.trim().slice(0, 160) || 'reason unrecorded'}). Restic restore or FAST PATH copy silently failed — tenant Domains and mailboxes are GONE. Do NOT mark this migration done. Investigate the init container logs and the backup target reachability.`,
      };
    }
  } catch (err) {
    // Exec timeout / pod gone — treat as verification failure (safer
    // than silently succeeding on an unverifiable pod).
    return { ok: false, reason: `failed to probe Stalwart pod for fresh-start sentinel: ${err instanceof Error ? err.message : String(err)}` };
  }

  // (b) + (c): live JMAP checks. Read the admin creds + post via exec.
  let auth: string;
  try {
    const { username, password } = readStalwartCredentials(process.env);
    auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  } catch (err) {
    log.warn('[migration] verifyRestoreContent: Stalwart creds unavailable, skipping JMAP checks:', err);
    return { ok: false, reason: `Stalwart admin credentials unavailable; cannot verify restore content. ${err instanceof Error ? err.message : String(err)}` };
  }

  // (b) Every DB-tracked stalwart_domain_id must resolve in Stalwart.
  const expected = await db
    .select({ id: emailDomains.stalwartDomainId })
    .from(emailDomains)
    .where(isNotNull(emailDomains.stalwartDomainId));
  const expectedIds = expected.map((r) => r.id).filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (expectedIds.length > 0) {
    const present = await jmapDomainsExist(podName, auth, expectedIds, kubeconfigPath);
    if (present.kind === 'error') {
      return { ok: false, reason: `JMAP Domain check failed: ${present.message}` };
    }
    const missing = expectedIds.filter((id) => !present.foundIds.has(id));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `${missing.length} tenant Stalwart Domain(s) missing post-restore (ids: ${missing.slice(0, 5).join(',')}${missing.length > 5 ? '…' : ''}). Restic restore was incomplete — tenant mail data lost. Do NOT cut over.`,
      };
    }
  }

  // (c) Stalwart's individual-principal count must be >= DB mailbox count.
  // Allow slack: just-deleted mailboxes can still have lingering Stalwart
  // principals (cleanup is best-effort). Strict-less-than is the bug case.
  const [dbCount] = await db.select({ c: count() }).from(mailboxes);
  const expectedMailboxes = Number(dbCount?.c ?? 0);
  if (expectedMailboxes > 0) {
    const stalwartCount = await jmapCountIndividualPrincipals(podName, auth, kubeconfigPath);
    if (stalwartCount.kind === 'error') {
      return { ok: false, reason: `JMAP principal count failed: ${stalwartCount.message}` };
    }
    if (stalwartCount.count < expectedMailboxes) {
      return {
        ok: false,
        reason: `Stalwart has ${stalwartCount.count} individual principals; DB expects >= ${expectedMailboxes}. ${expectedMailboxes - stalwartCount.count} mailbox(es) missing post-restore. Do NOT cut over.`,
      };
    }
  }

  return { ok: true };
}

/** True iff `path` exists on the Stalwart container. Throws on exec timeout. */
async function podHasFile(podName: string, path: string, kubeconfigPath?: string): Promise<boolean> {
  const { Exec, KubeConfig } = await import('@kubernetes/client-node');
  const kc = new KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath); else kc.loadFromCluster();
  const exec = new Exec(kc);
  const { Writable } = await import('node:stream');
  const sink = new Writable({ write(_c, _e, cb) { cb(); } });
  return await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('podHasFile timed out')), 10_000);
    exec.exec(
      MAIL_NAMESPACE, podName, 'stalwart',
      ['test', '-f', path],
      sink, sink, null, false,
      (status) => {
        clearTimeout(timer);
        // `test -f` exits 0 if file exists, 1 if not — exec callback
        // surfaces non-zero as status.status='Failure'.
        resolve(status.status !== 'Failure');
      },
    ).catch(reject);
  });
}

/** Read up to 4 KB of `path` from the Stalwart container. Returns empty on error. */
async function readPodFile(podName: string, path: string, kubeconfigPath?: string): Promise<string> {
  try {
    const { Exec, KubeConfig } = await import('@kubernetes/client-node');
    const kc = new KubeConfig();
    if (kubeconfigPath) kc.loadFromFile(kubeconfigPath); else kc.loadFromCluster();
    const exec = new Exec(kc);
    const { Writable } = await import('node:stream');
    let stdout = '';
    const stdoutSink = new Writable({ write(c, _e, cb) { stdout += c.toString('utf8'); cb(); } });
    const errSink = new Writable({ write(_c, _e, cb) { cb(); } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('readPodFile timed out')), 5_000);
      exec.exec(
        MAIL_NAMESPACE, podName, 'stalwart',
        ['head', '-c', '4096', path],
        stdoutSink, errSink, null, false,
        () => { clearTimeout(timer); resolve(); },
      ).catch(reject);
    });
    return stdout;
  } catch {
    return '';
  }
}

/** x:Domain/get for a set of IDs. Returns the set of IDs Stalwart confirmed exist. */
async function jmapDomainsExist(
  podName: string,
  auth: string,
  ids: ReadonlyArray<string>,
  kubeconfigPath?: string,
): Promise<{ kind: 'ok'; foundIds: Set<string> } | { kind: 'error'; message: string }> {
  const body = {
    using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    methodCalls: [['x:Domain/get', { accountId: 'singleton', ids, properties: ['id'] }, 'c0']],
  };
  const res = await execJmap(podName, auth, body, kubeconfigPath);
  if (res.kind === 'error') return res;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args = (res.body as any)?.methodResponses?.[0]?.[1] as { list?: ReadonlyArray<{ id?: string }> } | undefined;
  const list = args?.list ?? [];
  const foundIds = new Set(list.map((d) => d.id).filter((x): x is string => typeof x === 'string'));
  return { kind: 'ok', foundIds };
}

/** Count individual principals in Stalwart (mailbox accounts). */
async function jmapCountIndividualPrincipals(
  podName: string,
  auth: string,
  kubeconfigPath?: string,
): Promise<{ kind: 'ok'; count: number } | { kind: 'error'; message: string }> {
  const body = {
    using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:principals'],
    methodCalls: [['Principal/query', { accountId: 'singleton', filter: { type: 'individual' } }, 'c0']],
  };
  const res = await execJmap(podName, auth, body, kubeconfigPath);
  if (res.kind === 'error') return res;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args = (res.body as any)?.methodResponses?.[0]?.[1] as { ids?: ReadonlyArray<unknown>; total?: number } | undefined;
  if (typeof args?.total === 'number') return { kind: 'ok', count: args.total };
  return { kind: 'ok', count: Array.isArray(args?.ids) ? args.ids.length : 0 };
}

async function execJmap(
  podName: string,
  auth: string,
  body: unknown,
  kubeconfigPath?: string,
): Promise<{ kind: 'ok'; body: unknown } | { kind: 'error'; message: string }> {
  try {
    const { Exec, KubeConfig } = await import('@kubernetes/client-node');
    const kc = new KubeConfig();
    if (kubeconfigPath) kc.loadFromFile(kubeconfigPath); else kc.loadFromCluster();
    const exec = new Exec(kc);
    const { Writable } = await import('node:stream');
    const payload = JSON.stringify(body);
    const escaped = payload.replace(/'/g, `'\\''`);
    const cmd = [
      'sh', '-c',
      `curl -sS -m 10 -H 'Authorization: ${auth}' -H 'Content-Type: application/json' -d '${escaped}' 'http://127.0.0.1:8080/jmap/'`,
    ];
    let stdout = '';
    let stderr = '';
    const stdoutSink = new Writable({ write(c, _e, cb) { stdout += c.toString('utf8'); cb(); } });
    const stderrSink = new Writable({ write(c, _e, cb) { stderr += c.toString('utf8'); cb(); } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('execJmap timed out')), 15_000);
      exec.exec(
        MAIL_NAMESPACE, podName, 'stalwart',
        cmd, stdoutSink, stderrSink, null, false,
        (status) => {
          clearTimeout(timer);
          if (status.status === 'Failure') {
            reject(new Error(`exec failure: ${status.message ?? 'unknown'} stderr=${stderr.slice(0, 200)}`));
          } else {
            resolve();
          }
        },
      ).catch(reject);
    });
    if (!stdout.trim()) return { kind: 'error', message: `empty JMAP response (stderr=${stderr.slice(0, 200)})` };
    try {
      return { kind: 'ok', body: JSON.parse(stdout) };
    } catch (parseErr) {
      return { kind: 'error', message: `JMAP response parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)} (body=${stdout.slice(0, 200)})` };
    }
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Preflight: validate the target node has a viable RESTORE PATH before the
// destructive PVC swap. See migration.ts:state-machine step 1 header for
// the operational reasoning.
// ─────────────────────────────────────────────────────────────────────────────

const MAIL_STANDBY_LABEL = 'platform.phoenix-host.net/mail-standby';
const RCLONE_SHIM_NAMESPACE = 'platform';
const RCLONE_SHIM_SERVICE = 'backup-rclone-shim';

interface TargetReadinessResult {
  readonly ok: boolean;
  /** Which restore path was selected. */
  readonly path?: 'fast_path_standby' | 'restic_shim';
  /** Operator-actionable reason on failure. */
  readonly reason: string;
}

async function validateTargetRestoreReadiness(
  core: CoreV1Api,
  targetNode: string,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<TargetReadinessResult> {
  // Check (a): is the target node labelled for standby data staging?
  // If yes, the standby DaemonSet should be running on it and FAST PATH
  // data will be present (or will be soon — the first pull after a
  // label flip takes one cadence interval = ~5 min).
  let nodeLabelled = false;
  try {
    const node = await core.readNode({ name: targetNode }) as {
      metadata?: { labels?: Record<string, string> };
    };
    nodeLabelled = node.metadata?.labels?.[MAIL_STANDBY_LABEL] === 'true';
  } catch (err) {
    return {
      ok: false,
      reason:
        `Could not read target node '${targetNode}' for label check: ${err instanceof Error ? err.message : String(err)}. ` +
        `Verify the node exists and is reachable via the cluster API before retrying.`,
    };
  }

  if (nodeLabelled) {
    // Standby-labelled target → FAST PATH ready (or imminent). Accept.
    // We DON'T verify the .standby-complete sentinel here because we
    // don't run a Pod on the target to inspect its hostPath — but the
    // init container will fall through to restic if the sentinel is
    // missing/stale, so a labelled-but-data-missing target is recoverable.
    log.info(`[preflight] target node ${targetNode} is labelled ${MAIL_STANDBY_LABEL}=true → FAST PATH ready`);
    return {
      ok: true,
      path: 'fast_path_standby',
      reason: '',
    };
  }

  // Check (b): backup-rclone-shim has ≥1 Ready pod? (restic fallback path).
  //
  // Pre-fix this used `readNamespacedEndpoints` which silently returned
  // empty subsets on k8s 1.33+ (the v1 Endpoints API is deprecated in
  // favor of discovery.k8s.io/v1 EndpointSlice). Caught on staging E2E
  // 2026-05-27 — preflight wrongly reported "no Endpoints" even though
  // 4 shim pods were Running. Counting Ready pods directly is robust
  // across k8s versions and is the same information from the operator's
  // standpoint (a Ready pod = a backend the Service routes to).
  let shimEndpointCount = 0;
  try {
    const pods = await core.listNamespacedPod({
      namespace: RCLONE_SHIM_NAMESPACE,
      labelSelector: `app=${RCLONE_SHIM_SERVICE}`,
    }) as {
      items: ReadonlyArray<{
        status?: {
          phase?: string;
          conditions?: ReadonlyArray<{ type?: string; status?: string }>;
        };
      }>;
    };
    shimEndpointCount = pods.items.filter((p) => {
      if (p.status?.phase !== 'Running') return false;
      const ready = p.status?.conditions?.find((c) => c.type === 'Ready');
      return ready?.status === 'True';
    }).length;
  } catch (err) {
    log.warn(
      `[preflight] reading backup-rclone-shim pods failed (treating as 0): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (shimEndpointCount === 0) {
    return {
      ok: false,
      reason:
        `Target node '${targetNode}' is NOT labelled '${MAIL_STANDBY_LABEL}=true' (no FAST PATH standby data staged) ` +
        `AND backup-rclone-shim has no Endpoints (restic fallback unreachable). Either ` +
        `(a) label the target node 'kubectl label node ${targetNode} ${MAIL_STANDBY_LABEL}=true' AND wait ~5 min ` +
        `for the standby DaemonSet to stage data, OR ` +
        `(b) fix the backup-rclone-shim Deployment in the platform namespace so it has Ready pods. ` +
        `Migration refused to avoid silent data loss during destructive PVC swap.`,
    };
  }

  // Restic shim has endpoints, but reachability from the SPECIFIC target
  // node depends on CNI/NetworkPolicy state — a server-role node usually
  // reaches the shim fine, a worker-role node with ingress-mode=local may
  // be blocked by NetworkPolicy. Warn the operator but don't block —
  // a savvy operator may have already verified reachability out-of-band.
  log.info(
    `[preflight] target node ${targetNode} is NOT mail-standby-labelled; ` +
    `restic fallback path will be used (shim has ${shimEndpointCount} endpoints). ` +
    `If target is a worker-role node, verify NetworkPolicy allows egress to ${RCLONE_SHIM_SERVICE}.${RCLONE_SHIM_NAMESPACE} ` +
    `before relying on this migration.`,
  );
  return {
    ok: true,
    path: 'restic_shim',
    reason: '',
  };
}

/**
 * True iff the operator has configured a mail BackupTarget via
 * /backups/mail → Targets. When false, the pre-migration restic backup
 * step (state-machine step 2) is skipped — running it would just fail
 * with missing RESTIC_REPOSITORY and waste 5 min on the wait.
 */
async function checkMailBackupTargetConfigured(db: Database): Promise<boolean> {
  try {
    const { backupTargetAssignments } = await import('../../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const rows = await db
      .select({ targetId: backupTargetAssignments.targetId })
      .from(backupTargetAssignments)
      .where(eq(backupTargetAssignments.backupClass, 'mail'))
      .limit(1);
    return rows.length > 0;
  } catch {
    // On DB error, assume target IS configured — better to attempt the
    // backup and let the snapshot Pod surface the real failure than to
    // silently skip a step the operator may need.
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Broken-state detection — drives the "Recover Mail" button visibility.
// ─────────────────────────────────────────────────────────────────────────────

export interface MailRecoveryStatus {
  /**
   * 'healthy' — Stalwart pod Ready on the active node.
   * 'broken'  — operator-actionable. Pod Pending/CrashLoopBackOff > 2 min,
   *             OR PVC bound on a node other than the active one.
   * 'unknown' — couldn't read state (cluster API error).
   */
  readonly state: 'healthy' | 'broken' | 'unknown';
  readonly reason: string | null;
  /** Node where the PVC is currently bound (actual reality). */
  readonly pvcNode: string | null;
  /** Node system_settings thinks is active. */
  readonly expectedActiveNode: string | null;
  /** Stalwart pod's current phase, or null when no pod. */
  readonly podPhase: string | null;
  /** Operator-suggested recovery target (mailPrimaryNode preferred). */
  readonly suggestedTargetNode: string | null;
}

const BROKEN_POD_AGE_THRESHOLD_MS = 2 * 60 * 1000;

export async function getMailRecoveryStatus(
  deps: { db: Database; core: CoreV1Api },
): Promise<MailRecoveryStatus> {
  let pvcNode: string | null = null;
  let podPhase: string | null = null;
  let podCreatedAt: number | null = null;
  let podWaitingReason: string | null = null;

  try {
    pvcNode = await readActualPvcBoundNode(deps.core);
  } catch (err) {
    // PVC read failure on a non-404 (cluster API flapping, RBAC drift,
    // network) means we can't tell whether the system is broken. Return
    // state='unknown' so the UI hides the recovery banner — better than
    // silently reporting healthy on a missing-PVC clue. The pod read
    // catch below uses the same pattern.
    return {
      state: 'unknown',
      reason: `Could not read mail-stack-data PVC: ${err instanceof Error ? err.message : String(err)}`,
      pvcNode: null,
      expectedActiveNode: null,
      podPhase: null,
      suggestedTargetNode: null,
    };
  }

  try {
    const pods = await deps.core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: 'app=stalwart-mail',
    }) as {
      items: ReadonlyArray<{
        status?: {
          phase?: string;
          startTime?: string;
          containerStatuses?: ReadonlyArray<{ state?: { waiting?: { reason?: string } } }>;
          initContainerStatuses?: ReadonlyArray<{ state?: { waiting?: { reason?: string } } }>;
        };
        metadata?: { creationTimestamp?: string };
      }>;
    };
    const p = pods.items[0];
    podPhase = p?.status?.phase ?? null;
    const created = p?.metadata?.creationTimestamp;
    podCreatedAt = created ? Date.parse(created) : null;
    podWaitingReason =
      p?.status?.initContainerStatuses?.[0]?.state?.waiting?.reason
      ?? p?.status?.containerStatuses?.[0]?.state?.waiting?.reason
      ?? null;
  } catch {
    return {
      state: 'unknown',
      reason: 'Could not read stalwart-mail pods from cluster API',
      pvcNode, expectedActiveNode: null, podPhase: null, suggestedTargetNode: null,
    };
  }

  const [row] = await deps.db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
  const expectedActiveNode = row?.mailActiveNode ?? null;
  const suggestedTargetNode = row?.mailPrimaryNode ?? row?.mailSecondaryNode ?? expectedActiveNode;

  // Healthy: pod Running + container Ready (close-enough: phase=Running and
  // no waiting reason on the main container). Init-time waiting is OK only
  // briefly (< 2 min); past that we treat it as broken.
  const podAgeMs = podCreatedAt ? Date.now() - podCreatedAt : 0;
  if (podPhase === 'Running' && !podWaitingReason) {
    // Cross-check PVC location matches the active node (per HA invariant
    // the PVC SHOULD be bound on mailActiveNode). Mismatch is a bug
    // state — the operator's recovery action realigns the two.
    if (pvcNode && expectedActiveNode && pvcNode !== expectedActiveNode) {
      return {
        state: 'broken',
        reason: `PVC bound on '${pvcNode}' but system thinks active node is '${expectedActiveNode}'. Recovery realigns them.`,
        pvcNode, expectedActiveNode, podPhase, suggestedTargetNode,
      };
    }
    return {
      state: 'healthy',
      reason: null,
      pvcNode, expectedActiveNode, podPhase, suggestedTargetNode,
    };
  }
  if (podPhase === 'Pending' && podAgeMs > BROKEN_POD_AGE_THRESHOLD_MS) {
    return {
      state: 'broken',
      reason: `stalwart-mail pod stuck Pending for ${Math.floor(podAgeMs / 60_000)} min${podWaitingReason ? ` (waiting: ${podWaitingReason})` : ''}. PVC currently bound on '${pvcNode ?? 'unknown'}'.`,
      pvcNode, expectedActiveNode, podPhase, suggestedTargetNode,
    };
  }
  if (podWaitingReason && ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull'].includes(podWaitingReason)) {
    return {
      state: 'broken',
      reason: `stalwart-mail container in ${podWaitingReason}. PVC currently bound on '${pvcNode ?? 'unknown'}'.`,
      pvcNode, expectedActiveNode, podPhase, suggestedTargetNode,
    };
  }
  // Transient (Pending < 2 min, no waiting reason) — defer judgement.
  return {
    state: 'healthy',
    reason: null,
    pvcNode, expectedActiveNode, podPhase, suggestedTargetNode,
  };
}
