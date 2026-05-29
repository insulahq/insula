/**
 * Mail snapshot schedule + backup target management.
 *
 * Schedule is stored in k8s (CronJob spec.schedule) as the source of
 * truth; system_settings.mail_snapshot_schedule mirrors it for the UI
 * to read without a k8s round-trip.
 *
 * Backup target is stored in system_settings.mail_snapshot_backup_store_id
 * (FK to backup_configurations.id). When set, the backend maintains the
 * stalwart-snapshot-restic-repo Secret in the mail namespace so the
 * upload sidecar can run restic without calling back to the API.
 *
 * GET   /admin/mail/snapshot-schedule
 * PATCH /admin/mail/snapshot-schedule
 * GET   /admin/mail/snapshot-backup-target
 * PATCH /admin/mail/snapshot-backup-target
 *
 * POST  /api/v1/internal/mail/snapshot-last-run   (sidecar callback)
 */

import { eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { systemSettings, backupConfigurations, backupTargetAssignments } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { applyPatch } from '../../shared/k8s-patch.js';

// Stable fieldManager — claims SSA ownership of spec.schedule so that
// Flux's `kustomize.toolkit.fluxcd.io/ssa: merge` reconciler stops
// reverting operator schedules back to the manifest default
// (2026-05-29 — the operator-set "*/10" silently regressed to "*/2"
// on every Flux reconcile because the manifest declares the field
// and STRATEGIC_MERGE_PATCH does not claim SSA ownership).
const CRON_SCHEDULE_FIELD_MANAGER = 'platform-api.snapshot-settings';
import { isNotFound } from '../../shared/k8s-errors.js';
import {
  type MailSnapshotScheduleResponse,
  type MailSnapshotScheduleUpdate,
  type MailSnapshotBackupTargetResponse,
  type MailSnapshotBackupTargetUpdate,
  mailSnapshotScheduleResponseSchema,
  mailSnapshotBackupTargetResponseSchema,
} from '@k8s-hosting/api-contracts';

const MAIL_NAMESPACE = 'mail';
const SNAPSHOT_CRONJOB_NAME = 'stalwart-snapshot';
const SETTINGS_ID = 'system';
const RESTIC_SECRET_NAME = 'stalwart-snapshot-restic-repo';
const RESTIC_PASSWORD_SECRET = 'stalwart-snapshot-restic-password';

export interface SnapshotSettingsOptions {
  readonly kubeconfigPath: string | undefined;
}

interface K8sBatchTenant {
  batch: import('@kubernetes/client-node').BatchV1Api;
  core: import('@kubernetes/client-node').CoreV1Api;
}

// getOrCreateResticPassword moved to mail-target-sync.ts (re-exported
// from there). rotateResticPassword (below) only deletes the password
// Secret — the next sync regenerates a fresh password on its first
// readNamespacedSecret miss.

/**
 * Rotate the restic repository password.
 *
 * Deletes the existing `stalwart-snapshot-restic-password` Secret so the next
 * backup-target update generates a fresh password.
 *
 * IMPORTANT: After rotation, any existing restic repository will no longer be
 * accessible with the new password. Operators must run `restic rekey` on the
 * repository before the next backup runs, or accept that history is inaccessible
 * until the repo is re-initialised (first backup after rotation recreates it).
 */
export async function rotateResticPassword(opts: SnapshotSettingsOptions): Promise<{ status: string }> {
  const { core } = await loadK8sTenants(opts.kubeconfigPath);
  try {
    await core.deleteNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      name: RESTIC_PASSWORD_SECRET,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // Already gone — fine.
  }
  return { status: 'password_rotated' };
}

async function loadK8sTenants(kubeconfigPath: string | undefined): Promise<K8sBatchTenant> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return {
    batch: kc.makeApiClient(k8s.BatchV1Api),
    core: kc.makeApiClient(k8s.CoreV1Api),
  };
}

// ── Schedule ──────────────────────────────────────────────────────────────────

/**
 * Read the current snapshot schedule from the CronJob spec.
 * Falls back to the system_settings DB value (in case the CronJob
 * is temporarily absent) and then to the default.
 */
export async function getMailSnapshotSchedule(
  db: Database,
  opts: SnapshotSettingsOptions,
): Promise<MailSnapshotScheduleResponse> {
  // Try k8s first — it is authoritative.
  try {
    const { batch } = await loadK8sTenants(opts.kubeconfigPath);
    const cronJob = await batch.readNamespacedCronJob({
      namespace: MAIL_NAMESPACE,
      name: SNAPSHOT_CRONJOB_NAME,
    }) as { spec?: { schedule?: string } };
    const scheduleExpression = cronJob.spec?.schedule ?? '*/2 * * * *';
    return mailSnapshotScheduleResponseSchema.parse({ scheduleExpression });
  } catch {
    // CronJob absent or k8s unavailable — fall back to DB.
  }
  const [row] = await db.select({ v: systemSettings.mailSnapshotSchedule })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID));
  return mailSnapshotScheduleResponseSchema.parse({
    scheduleExpression: row?.v ?? '*/2 * * * *',
  });
}

/**
 * Update the snapshot schedule by patching the CronJob spec.schedule
 * and persisting the value to system_settings.
 */
export async function updateMailSnapshotSchedule(
  update: MailSnapshotScheduleUpdate,
  db: Database,
  opts: SnapshotSettingsOptions,
): Promise<MailSnapshotScheduleResponse> {
  const { batch } = await loadK8sTenants(opts.kubeconfigPath);

  try {
    await batch.patchNamespacedCronJob(
      {
        namespace: MAIL_NAMESPACE,
        name: SNAPSHOT_CRONJOB_NAME,
        // Apply-patch body must include apiVersion + kind so the
        // apiserver can resolve the GVK during SSA.
        body: {
          apiVersion: 'batch/v1',
          kind: 'CronJob',
          metadata: { name: SNAPSHOT_CRONJOB_NAME, namespace: MAIL_NAMESPACE },
          spec: { schedule: update.scheduleExpression },
        },
      } as unknown as Parameters<typeof batch.patchNamespacedCronJob>[0],
      applyPatch(CRON_SCHEDULE_FIELD_MANAGER, { force: true }),
    );
  } catch (err) {
    throw new ApiError(
      'SNAPSHOT_SCHEDULE_PATCH_FAILED',
      `Failed to patch CronJob schedule: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }

  await db.update(systemSettings)
    .set({ mailSnapshotSchedule: update.scheduleExpression })
    .where(eq(systemSettings.id, SETTINGS_ID));

  return mailSnapshotScheduleResponseSchema.parse({
    scheduleExpression: update.scheduleExpression,
  });
}

// ── Backup target ─────────────────────────────────────────────────────────────

/**
 * Read the currently configured backup target for mail snapshots.
 *
 * Phase 2 legacy purge (2026-05-22): source of truth moved from
 * `backup_target_assignments[backup_class='mail']` (the R-X shim's `mail` class) and the
 * R-X8 shim `mail` class. The mail-restic-shim reconciler owns the
 * stalwart-snapshot-restic-repo Secret materialisation on every
 * binding change — no separate sync needed.
 */
export async function getMailSnapshotBackupTarget(
  db: Database,
): Promise<MailSnapshotBackupTargetResponse> {
  const [row] = await db
    .select({
      targetId: backupTargetAssignments.targetId,
      targetName: backupConfigurations.name,
      storageType: backupConfigurations.storageType,
      enabled: backupConfigurations.enabled,
    })
    .from(backupTargetAssignments)
    .innerJoin(
      backupConfigurations,
      eq(backupConfigurations.id, backupTargetAssignments.targetId),
    )
    .where(eq(backupTargetAssignments.backupClass, 'mail'))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);

  if (row && row.enabled === 1) {
    return mailSnapshotBackupTargetResponseSchema.parse({
      backupStoreId: row.targetId,
      backupStoreName: row.targetName,
      storageType: row.storageType,
    });
  }

  return mailSnapshotBackupTargetResponseSchema.parse({
    backupStoreId: null,
    backupStoreName: null,
    storageType: null,
  });
}

/**
 * Update the backup target for mail snapshots — passthrough writer.
 *
 * Phase 2 legacy purge (2026-05-22): writes the `mail` shim class
 * assignment in one transaction. The mail-restic-shim reconciler
 * picks up the binding change on its 5-minute tick (or inline via
 * the assignments PUT endpoint when an operator uses the new
 * /backups/mail UI). This endpoint is left in place for backward-
 * compatibility of the legacy /admin/mail/snapshot-backup-target
 * PATCH route until the corresponding UI is replaced.
 *
 * Behaviour:
 *   - update.backupStoreId === null → clears the mail assignment.
 *     Mail-restic-shim notices the empty binding on next tick and
 *     removes the stalwart-snapshot-restic-repo Secret.
 *   - non-null → validates target exists + enabled, writes the row.
 */
export async function updateMailSnapshotBackupTarget(
  update: MailSnapshotBackupTargetUpdate,
  db: Database,
  _opts: SnapshotSettingsOptions,
  _encryptionKey: string,
): Promise<MailSnapshotBackupTargetResponse> {
  if (!update.backupStoreId) {
    await db
      .delete(backupTargetAssignments)
      .where(eq(backupTargetAssignments.backupClass, 'mail'));
    return mailSnapshotBackupTargetResponseSchema.parse({
      backupStoreId: null,
      backupStoreName: null,
      storageType: null,
    });
  }

  // Validate target exists + is enabled BEFORE replacing the
  // assignment row — operator gets a clean 400 instead of an opaque
  // FK error if they pick a stale id.
  const [target] = await db
    .select({
      id: backupConfigurations.id,
      name: backupConfigurations.name,
      storageType: backupConfigurations.storageType,
      enabled: backupConfigurations.enabled,
    })
    .from(backupConfigurations)
    .where(eq(backupConfigurations.id, update.backupStoreId))
    .limit(1);

  if (!target) {
    throw new ApiError(
      'TARGET_NOT_FOUND',
      `backup_configurations row ${update.backupStoreId} not found`,
      400,
    );
  }
  if (target.enabled !== 1) {
    throw new ApiError(
      'TARGET_DISABLED',
      `backup_configurations row ${update.backupStoreId} is disabled — enable it before binding to the mail class`,
      400,
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(backupTargetAssignments)
      .where(eq(backupTargetAssignments.backupClass, 'mail'));
    await tx.insert(backupTargetAssignments).values({
      backupClass: 'mail',
      targetId: target.id,
      priority: 0,
    });
  });

  return mailSnapshotBackupTargetResponseSchema.parse({
    backupStoreId: target.id,
    backupStoreName: target.name,
    storageType: target.storageType,
  });
}

/**
 * Internal endpoint: record stats from the restic upload sidecar.
 * POST /api/v1/internal/mail/snapshot-last-run
 */
export async function recordMailSnapshotLastRun(
  db: Database,
  stats: { totalSnapshotSizeBytes: number; snapshotCount: number },
): Promise<void> {
  await db.update(systemSettings)
    .set({
      mailSnapshotLastRunStats: {
        totalSnapshotSizeBytes: stats.totalSnapshotSizeBytes,
        snapshotCount: stats.snapshotCount,
        runAt: new Date().toISOString(),
      },
    })
    .where(eq(systemSettings.id, SETTINGS_ID));
}

// Phase 2 legacy purge (2026-05-22): the stalwart-snapshot-restic-repo
// Secret is now owned by backup-rclone-shim/mail-restic.ts's reconciler.
// This file is just the HTTP-facing surface for the legacy
// /admin/mail/snapshot-target endpoint; it reads/writes the `mail`
// shim class directly and lets the shim reconciler materialise the
// Secret on its 5-minute tick (or inline via the apply-assignment
// pipeline when an operator uses the new /backups/mail UI).

// ─────────────────────────────────────────────────────────────────────────────
// Retention reconciler (2026-05-27)
//
// Pre-fix: snapshot-upload.sh hardcoded `restic forget --keep-last 48`.
// Operator-set values in backup_schedules.mail (retention_days +
// retention_count) had zero effect — the UI accepted the input, the DB
// stored it, but the actual restic forget command never saw it.
//
// This reconciler reads backup_schedules[mail] and patches the
// stalwart-snapshot CronJob's RETENTION_DAYS + RETENTION_COUNT env vars.
// snapshot-upload.sh reads those env vars and builds the restic forget
// args dynamically. Default fallback (--keep-last 48) preserved for
// safety if both env vars are unset/0.
//
// Trigger points:
//   - Inline call from backup-schedules.updateSchedule when subsystem='mail'
//     so the operator's PATCH takes effect on the NEXT snapshot fire
//     (~2 min worst case).
//   - Platform-api startup self-heal: catches drift if a previous reconcile
//     was interrupted or the manifest defaults override a real config.
// ─────────────────────────────────────────────────────────────────────────────

export async function applyMailSnapshotRetention(
  db: Database,
  opts: SnapshotSettingsOptions,
): Promise<{ retentionDays: number; retentionCount: number; patched: boolean; cronExpression: string | null }> {
  const { backupSchedules } = await import('../../db/schema.js');

  const [row] = await db
    .select({
      retentionDays: backupSchedules.retentionDays,
      retentionCount: backupSchedules.retentionCount,
      cronExpression: backupSchedules.cronExpression,
    })
    .from(backupSchedules)
    .where(eq(backupSchedules.subsystem, 'mail'));

  // No backup_schedules row → use safe legacy defaults (matches
  // snapshot-upload.sh fallback when ConfigMap is missing).
  const retentionDays = row?.retentionDays ?? 0;
  const retentionCount = row?.retentionCount ?? 48;
  // 2026-05-28: also reconcile the CronJob's spec.schedule from
  // backup_schedules.cron_expression. Pre-fix, this column was written
  // by /admin/backups/schedules/mail but never propagated to k8s; only
  // /admin/mail/snapshot-schedule patched the CronJob, so operators
  // using the unified Backups → Mail schedule editor saw their setting
  // silently ignored. Both surfaces now drive the same CronJob.
  const cronExpression = row?.cronExpression ?? null;

  const { core, batch } = await loadK8sTenants(opts.kubeconfigPath);

  // Write/update the mail-snapshot-retention ConfigMap.
  //
  // We OWN this ConfigMap exclusively. Flux's kustomize-controller is
  // NOT given a manifest for it — deliberate (caught 2026-05-27: when
  // the retention env was on the CronJob spec, Flux's kustomize Apply
  // reverted operator-set values on its 5-10 min reconcile cycle).
  // The CronJob template uses `envFrom: configMapRef` with optional:true
  // so an absent ConfigMap falls back to snapshot-upload.sh's
  // --keep-last 48 default.
  const desiredBody = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: RETENTION_CONFIGMAP_NAME,
      namespace: MAIL_NAMESPACE,
      labels: {
        'app.kubernetes.io/component': 'mail-snapshot-retention',
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    data: {
      RETENTION_DAYS: String(retentionDays),
      RETENTION_COUNT: String(retentionCount),
    },
  };

  try {
    await core.readNamespacedConfigMap({
      name: RETENTION_CONFIGMAP_NAME,
      namespace: MAIL_NAMESPACE,
    });
    // Exists — replace.
    await core.replaceNamespacedConfigMap({
      name: RETENTION_CONFIGMAP_NAME,
      namespace: MAIL_NAMESPACE,
      body: desiredBody as unknown as object,
    });
  } catch (err) {
    if (isNotFound(err)) {
      try {
        await core.createNamespacedConfigMap({
          namespace: MAIL_NAMESPACE,
          body: desiredBody as unknown as object,
        });
      } catch (createErr) {
        throw new ApiError(
          'SNAPSHOT_RETENTION_CONFIGMAP_CREATE_FAILED',
          `Failed to create ${RETENTION_CONFIGMAP_NAME} ConfigMap: ${(createErr as Error).message ?? String(createErr)}`,
          500,
        );
      }
    } else {
      throw new ApiError(
        'SNAPSHOT_RETENTION_CONFIGMAP_UPDATE_FAILED',
        `Failed to update ${RETENTION_CONFIGMAP_NAME} ConfigMap: ${(err as Error).message ?? String(err)}`,
        500,
      );
    }
  }

  // Reconcile CronJob schedule from backup_schedules.cron_expression.
  // Skipped when no cron value set (DB row absent) — the manifest
  // default takes over. NEVER throws — schedule sync is best-effort
  // so retention reconcile still wins.
  if (cronExpression) {
    try {
      await batch.patchNamespacedCronJob(
        {
          namespace: MAIL_NAMESPACE,
          name: SNAPSHOT_CRONJOB_NAME,
          body: {
            apiVersion: 'batch/v1',
            kind: 'CronJob',
            metadata: { name: SNAPSHOT_CRONJOB_NAME, namespace: MAIL_NAMESPACE },
            spec: { schedule: cronExpression },
          },
        } as unknown as Parameters<typeof batch.patchNamespacedCronJob>[0],
        applyPatch(CRON_SCHEDULE_FIELD_MANAGER, { force: true }),
      );
    } catch (err) {
      // Don't fail the whole reconcile if the schedule patch fails —
      // retention still applied. Operator gets the warning in logs.
      // eslint-disable-next-line no-console
      console.warn('[snapshot-settings] failed to patch CronJob schedule:', err);
    }
  }

  return { retentionDays, retentionCount, patched: true, cronExpression };
}

const RETENTION_CONFIGMAP_NAME = 'mail-snapshot-retention';
