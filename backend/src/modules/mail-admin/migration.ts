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
import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { MERGE_PATCH, strategicMergePatch } from '../../shared/k8s-patch.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import { waitForStalwartReplicaCount } from './rollout-wait.js';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { triggerMailSnapshot } from './snapshot.js';
import { parseQuantity } from './mail-pvc.js';

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

  const sourceNode = row?.mailActiveNode ?? row?.mailPrimaryNode ?? null;
  if (!sourceNode) {
    throw new ApiError('MAIL_NO_ACTIVE_NODE', 'No active mail node is configured in system_settings', 409);
  }
  // Defense-in-depth: the Zod schema (`kubernetesNodeNameSchema`)
  // enforces RFC 1123 on inbound API payloads, but `sourceNode` is
  // read from `system_settings.mailActiveNode` and that column may
  // have been written by a pre-validation code path.
  if (!/^[a-z0-9]([a-z0-9-.]{0,251}[a-z0-9])?$/.test(sourceNode)) {
    throw new ApiError(
      'MAIL_INVALID_SOURCE_NODE',
      `Active mail node '${sourceNode}' is not a valid RFC 1123 hostname — refusing to migrate. Fix system_settings.mailActiveNode manually.`,
      500,
    );
  }
  if (sourceNode === targetNode) {
    throw new ApiError('MAIL_MIGRATION_SAME_NODE', 'Source and target nodes are the same', 400);
  }

  // **Phase 1 streamline (2026-05-15) precondition** — Phase K live-test
  // on staging surfaced a fatal gap: the migration architecture deletes
  // the source PVC and relies on the snapshot CronJob's restic backup
  // to restore data on the target node. If no backup target is
  // configured, the snapshot CronJob silently no-ops AND
  // `triggerMailSnapshot` succeeds without producing a real snapshot —
  // the migration then deletes the PVC and the restore-state
  // initContainer has nothing to restore. The DataStore is lost.
  //
  // Refuse migration when no `mailSnapshotBackupStoreId` is set. The
  // UI surfaces this gap via the Phase 10 backup-target CTA on
  // MailSnapshotHealthCard, but a programmatic caller hitting
  // /admin/mail/migrate directly needs this hard-fail.
  if (!row?.mailSnapshotBackupStoreId) {
    throw new ApiError(
      'MAIL_MIGRATION_NO_BACKUP_TARGET',
      'Mail migration requires a configured backup target. Go to Settings → Backups to add a CIFS / S3 / Hetzner-Storage-Box BackupStore, then Email Management → Operations → Backups to select it.',
      412, // Precondition Failed
    );
  }

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
  void runMigrationStateMachine(runId, sourceNode, targetNode, deps, newGiB, undefined, taskId).catch(async (err) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.execute(sql`
      UPDATE mail_migration_runs
      SET state = 'failed', error_message = ${errMsg}, finished_at = now()
      WHERE id = ${runId}
    `).catch(() => { /* best-effort */ });
    if (taskId) {
      try {
        const { finish: finishTask } = await import('../tasks/service.js');
        await finishTask(db, taskId, { status: 'failed', error: errMsg });
      } catch { /* best-effort */ }
    }
  });

  return { runId, taskId };
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

  // DR-mode flag: skip the on-demand snapshot (source unreachable).
  await runMigrationStateMachine(runId, sourceNode, targetNode, {
    ...deps,
    kubeconfigPath: deps.kubeconfigPath,
    logger: { warn: log.warn.bind(log), info: log.info.bind(log) },
  } as MigrationDeps, undefined, { skipFreshSnapshot: true }).catch(async (err) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.execute(sql`
      UPDATE mail_migration_runs
      SET state = 'failed', error_message = ${errMsg}, finished_at = now()
      WHERE id = ${runId}
    `).catch(() => { /* best-effort */ });
  });

  await db.update(systemSettings)
    .set({ mailActiveNode: targetNode, mailDrState: 'failed-over' })
    .where(eq(systemSettings.id, SETTINGS_ID));
}

// ── State machine internals ───────────────────────────────────────────────────

interface MigrationOptions {
  readonly skipFreshSnapshot?: boolean;
}

/**
 * Map state-machine step keys to operator-visible progress text +
 * pct. The order matches `runMigrationStateMachine` exactly.
 */
const MIGRATION_STEP_META: Record<string, { label: string; pct: number }> = {
  preflight: { label: 'Preflight checks', pct: 5 },
  snapshotting: { label: 'Triggering fresh snapshot', pct: 15 },
  'scaling-down': { label: 'Scaling Stalwart to 0', pct: 30 },
  'swapping-pvc': { label: 'Swapping PVC to target node', pct: 50 },
  'scaling-up': { label: 'Restoring DataStore on target node', pct: 80 },
  verifying: { label: 'Verifying RocksDB sentinel', pct: 95 },
  done: { label: 'Migration complete', pct: 100 },
};

async function setStep(
  db: Database,
  runId: string,
  step: string,
  state = 'running',
  taskId?: string | null,
): Promise<void> {
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
  await setStep(db, runId, 'preflight', 'running', taskId);
  const usedBytes = await getMailPvcRequestedBytes(core);
  const requiredBytes = Math.ceil(usedBytes * DISK_HEADROOM_RATIO);
  // Real free-disk probe would spawn a Job on targetNode. For now we
  // use the PVC's requested size as a conservative upper bound; if the
  // target node lacks the disk, the local-path provisioner will fail
  // PV creation and the migration aborts at the "swapping-pvc" step.
  log.info(`[migration ${runId}] preflight: PVC requested=${usedBytes} bytes, target headroom=${requiredBytes}`);

  // Step 2: Trigger a fresh snapshot (skip for DR — source is dead)
  if (!opts.skipFreshSnapshot) {
    await setStep(db, runId, 'snapshotting', 'running', taskId);
    try {
      await triggerMailSnapshot({ kubeconfigPath });
      // Wait until the snapshot completes. The snapshot CronJob runs
      // every 2 minutes; an on-demand trigger usually completes in
      // 20-60s for small DataStores. We poll for up to 5 min.
      await waitForFreshSnapshot(deps, 300);
    } catch (snapErr) {
      log.warn('[migration] fresh snapshot failed; will fall back to latest CronJob snapshot:', snapErr);
    }
  }

  // Step 3: Scale Stalwart to 0 (releases the source PVC mount)
  await setStep(db, runId, 'scaling-down', 'running', taskId);
  await patchDeploymentReplicas(apps, 0);
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
    await failRun(db, runId, `failed to recreate PVC on target node: ${(err as Error).message}`, taskId);
    return;
  }

  try {
    await applyDeploymentAffinity(apps, targetNode, /* allowRestore */ true);
  } catch (err) {
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

  // Step 6: Verify the CURRENT sentinel (RocksDB MANIFEST file) exists
  // in the new PVC. Its presence proves the restore completed AND
  // Stalwart successfully opened the DataStore.
  await setStep(db, runId, 'verifying', 'running', taskId);
  const podName = await findStalwartPod(core);
  if (podName) {
    const verified = await verifySentinelExists(podName);
    if (!verified) {
      await failRun(db, runId, 'DataStore CURRENT sentinel not found after migration — restore may have failed', taskId);
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
 */
async function deletePvcAndWait(core: CoreV1Api, name: string, timeoutSeconds: number): Promise<void> {
  try {
    await core.deleteNamespacedPersistentVolumeClaim({ name, namespace: MAIL_NAMESPACE });
  } catch (err) {
    if (isNotFound(err)) return; // already gone
    throw err;
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      await core.readNamespacedPersistentVolumeClaim({ name, namespace: MAIL_NAMESPACE });
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
): Promise<void> {
  const body = {
    metadata: allowRestore
      ? { annotations: { [ALLOW_RESTORE_ANNOTATION]: 'true' } }
      : undefined,
    spec: {
      template: {
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
 * `allowRestore` only stamps the annotation on Stalwart (it has no
 * meaning for Bulwark today; A2 will give Bulwark its own restore
 * path that consumes the same annotation).
 */
export async function applyDeploymentAffinity(
  apps: AppsV1Api,
  targetNode: string,
  allowRestore: boolean,
): Promise<void> {
  for (const name of MAIL_STACK_DEPLOYMENTS) {
    const stamp = allowRestore && name === DEPLOYMENT_NAME;
    await applyDeploymentAffinityOne(apps, name, targetNode, stamp);
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
 * Remove the `mail.platform/allow-restore` annotation after a
 * successful migration so subsequent pod restarts don't trigger the
 * restore-state initContainer's restic path.
 *
 * Uses merge-patch with `null` to delete the key (RFC 7396 semantics).
 * Stalwart-only — Bulwark has no restore-state init container today.
 */
async function clearAllowRestoreAnnotation(apps: AppsV1Api): Promise<void> {
  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name: DEPLOYMENT_NAME,
      body: {
        metadata: {
          annotations: { [ALLOW_RESTORE_ANNOTATION]: null },
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

async function verifySentinelExists(podName: string): Promise<boolean> {
  try {
    const { Exec, KubeConfig } = await import('@kubernetes/client-node');
    const kc = new KubeConfig();
    kc.loadFromCluster();
    const exec = new Exec(kc);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('verify timed out')), 10_000);
      void import('node:stream').then(({ Writable }) => {
        const sink = new Writable({ write(_c, _e, cb) { cb(); } });
        exec.exec(
          MAIL_NAMESPACE, podName, 'stalwart',
          ['test', '-f', '/var/lib/stalwart/data/CURRENT'],
          sink, sink, null, false,
          (status) => {
            clearTimeout(timer);
            if (status.status === 'Failure') {
              reject(new Error(`CURRENT sentinel missing: ${status.message ?? ''}`));
            } else {
              resolve();
            }
          },
        ).catch(reject);
      });
    });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
