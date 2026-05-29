/**
 * stalwart-snapshot CronJob reconciler (mail backup gating).
 *
 * Mirrors the system-class etcd-snap-via-shim reconciler
 * (backup-rclone-shim/etcd-cronjob.ts), but for the mail snapshot
 * CronJob, and owns TWO fields:
 *
 *   1. spec.suspend — flipped false ONLY when a mail backup target is
 *      bound (backup_target_assignments[mail] → enabled config). A
 *      restic backup with no target is pointless pod churn: the job
 *      script just logs "RESTIC_REPOSITORY not set — skipping upload"
 *      every cadence. Ships `suspend: true`; this reconciler enables it
 *      once a target exists, and re-suspends when it's removed.
 *
 *   2. spec.schedule — SSA-asserted (default "*​/30 * * * *", or the
 *      operator value in backup_schedules.mail.cron_expression — the
 *      same column applyMailSnapshotRetention reads, NOT the legacy
 *      system_settings.mailSnapshotSchedule)
 *      under the SAME field manager the operator PATCH uses
 *      (platform-api.snapshot-settings). This CLAIMS SSA ownership of
 *      the field on startup so that the Flux Kustomization-CR patch
 *      removing /spec/schedule leaves a valid live value — without an
 *      owner, a FRESH bootstrap's stripped (schedule-less) apply fails
 *      the apiserver's required-field validation and the `platform`
 *      Kustomization never goes Ready.
 *
 * Flux strips BOTH /spec/schedule and /spec/suspend from its apply
 * (scripts/bootstrap.sh Kustomization CR), so it never reverts either
 * field. This reconciler + the operator PATCH are the sole owners.
 */

import { eq } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';

import { backupConfigurations, backupTargetAssignments, backupSchedules } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { JSON_PATCH, applyPatch } from '../../shared/k8s-patch.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAIL_SNAPSHOT_CRONJOB_NAMESPACE = 'mail';
export const MAIL_SNAPSHOT_CRONJOB_NAME = 'stalwart-snapshot';

/** Default cadence when the operator has not set an override. */
export const DEFAULT_MAIL_SNAPSHOT_SCHEDULE = '*/30 * * * *';

/** Same SSA field manager the operator PATCH uses for spec.schedule. */
const CRON_SCHEDULE_FIELD_MANAGER = 'platform-api.snapshot-settings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MailSnapshotCronJobClients {
  readonly batch: k8s.BatchV1Api;
}

export interface MailSnapshotCronJobResult {
  readonly state: 'STATE_OK' | 'STATE_NO_MAIL_TARGET' | 'STATE_NOT_INSTALLED' | 'STATE_ERROR';
  readonly errorMessage: string;
  readonly suspended: boolean;
  readonly schedule: string;
  /** Whether any apiserver write was issued this pass. */
  readonly patched: boolean;
}

interface CronJobView {
  spec?: {
    suspend?: boolean;
    schedule?: string;
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * One reconcile pass. Idempotent — re-running with unchanged inputs is
 * a no-op (live spec is read first; writes are issued only on mismatch).
 *
 * 404 → STATE_NOT_INSTALLED (Flux hasn't synced base/stalwart-mail yet);
 * the periodic tick converges once it does.
 */
export async function reconcileMailSnapshotCronJob(
  db: Database,
  clients: MailSnapshotCronJobClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<MailSnapshotCronJobResult> {
  // ─── 1. Desired state from the DB ──────────────────────────────
  const bound = await isMailTargetBound(db);
  const desiredSuspend = !bound;
  const desiredSchedule = await resolveDesiredSchedule(db);

  // ─── 2. Read the live CronJob ──────────────────────────────────
  let live: CronJobView;
  try {
    live = (await clients.batch.readNamespacedCronJob({
      name: MAIL_SNAPSHOT_CRONJOB_NAME,
      namespace: MAIL_SNAPSHOT_CRONJOB_NAMESPACE,
    } as unknown as Parameters<typeof clients.batch.readNamespacedCronJob>[0])) as CronJobView;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) {
      log.warn(
        { name: MAIL_SNAPSHOT_CRONJOB_NAME },
        'mail-snapshot-cronjob: CronJob not yet installed (Flux not synced); skipping',
      );
      return {
        state: 'STATE_NOT_INSTALLED',
        errorMessage: '',
        suspended: true,
        schedule: desiredSchedule,
        patched: false,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'mail-snapshot-cronjob: read failed');
    return { state: 'STATE_ERROR', errorMessage: msg, suspended: desiredSuspend, schedule: desiredSchedule, patched: false };
  }

  // The manifest ships `suspend: true`, so the field is always present
  // after Flux's first apply. Default to `true` (consistent with
  // etcd-cronjob.ts) so a missing field never reads as "running".
  const liveSuspend = live.spec?.suspend ?? true;
  const liveSchedule = live.spec?.schedule ?? '';
  let patched = false;

  // ─── 3a. Claim/refresh schedule ownership (SSA) ────────────────
  // Always SSA-apply on first divergence: this is what establishes the
  // platform-api.snapshot-settings ownership the Flux schedule-strip
  // depends on. Skipped only when the live value already matches.
  if (liveSchedule !== desiredSchedule) {
    try {
      await clients.batch.patchNamespacedCronJob(
        {
          name: MAIL_SNAPSHOT_CRONJOB_NAME,
          namespace: MAIL_SNAPSHOT_CRONJOB_NAMESPACE,
          body: {
            apiVersion: 'batch/v1',
            kind: 'CronJob',
            metadata: { name: MAIL_SNAPSHOT_CRONJOB_NAME, namespace: MAIL_SNAPSHOT_CRONJOB_NAMESPACE },
            spec: { schedule: desiredSchedule },
          },
        } as unknown as Parameters<typeof clients.batch.patchNamespacedCronJob>[0],
        applyPatch(CRON_SCHEDULE_FIELD_MANAGER, { force: true }),
      );
      patched = true;
      log.info(
        { name: MAIL_SNAPSHOT_CRONJOB_NAME, previous: liveSchedule, next: desiredSchedule },
        'mail-snapshot-cronjob: spec.schedule asserted (SSA ownership)',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'mail-snapshot-cronjob: schedule apply failed');
      return { state: 'STATE_ERROR', errorMessage: msg, suspended: liveSuspend, schedule: liveSchedule, patched };
    }
  }

  // ─── 3b. Toggle suspend (JSON-patch) ───────────────────────────
  // `replace` is safe because the manifest always ships `suspend: true`
  // (the field is present after Flux's first apply). If the manifest
  // ever drops it, the first flip would 422 and the next tick's SSA
  // schedule assert would not help — keep the field in the manifest.
  if (liveSuspend !== desiredSuspend) {
    const op = [{ op: 'replace' as const, path: '/spec/suspend', value: desiredSuspend }];
    try {
      await clients.batch.patchNamespacedCronJob(
        {
          name: MAIL_SNAPSHOT_CRONJOB_NAME,
          namespace: MAIL_SNAPSHOT_CRONJOB_NAMESPACE,
          body: op as unknown as object,
        } as unknown as Parameters<typeof clients.batch.patchNamespacedCronJob>[0],
        JSON_PATCH,
      );
      patched = true;
      log.info(
        { name: MAIL_SNAPSHOT_CRONJOB_NAME, previous: liveSuspend, next: desiredSuspend, bound },
        'mail-snapshot-cronjob: spec.suspend toggled',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'mail-snapshot-cronjob: suspend patch failed');
      return { state: 'STATE_ERROR', errorMessage: msg, suspended: liveSuspend, schedule: desiredSchedule, patched };
    }
  }

  return {
    state: bound ? 'STATE_OK' : 'STATE_NO_MAIL_TARGET',
    errorMessage: '',
    suspended: desiredSuspend,
    schedule: desiredSchedule,
    patched,
  };
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

/** True when a mail-class backup target is assigned AND its config is enabled. */
async function isMailTargetBound(db: Database): Promise<boolean> {
  const rows = await db
    .select({ enabled: backupConfigurations.enabled })
    .from(backupTargetAssignments)
    .innerJoin(
      backupConfigurations,
      eq(backupConfigurations.id, backupTargetAssignments.targetId),
    )
    .where(eq(backupTargetAssignments.backupClass, 'mail'))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  if (rows.length === 0) return false;
  return rows[0].enabled === 1;
}

/**
 * Operator schedule (backup_schedules.mail.cron_expression) or the default.
 *
 * MUST read the SAME column as applyMailSnapshotRetention
 * (snapshot-settings.ts) — both SSA-assert spec.schedule under the
 * identical field manager `platform-api.snapshot-settings`, so if they
 * disagree on the source column they fight: this reconciler's periodic
 * tick would revert the operator's PATCH /admin/backups/schedules/mail
 * value. `backup_schedules.cron_expression` is the canonical operator
 * source (the unified Backups → Mail schedule editor); the legacy
 * system_settings.mailSnapshotSchedule column is NOT authoritative.
 */
async function resolveDesiredSchedule(db: Database): Promise<string> {
  const [row] = await db
    .select({ v: backupSchedules.cronExpression })
    .from(backupSchedules)
    .where(eq(backupSchedules.subsystem, 'mail'))
    .limit(1);
  const v = row?.v?.trim();
  return v && v.length > 0 ? v : DEFAULT_MAIL_SNAPSHOT_SCHEDULE;
}
