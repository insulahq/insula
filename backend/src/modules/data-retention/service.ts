// Data-retention pruning for append-only tables that otherwise grow
// unbounded over the life of a cluster.
//
// Audit (2026-06-01): every node/infra log vector is already capped
// (kubelet container-log rotation 10Mi×5, journald ~4G, etcd snapshot
// retention, kubelet image GC, Longhorn recurring-job retention, CNPG
// 30d barman retention). Most DB tables are pruned too (tasks,
// notifications, waf_logs, refresh_tokens, …). These four were the
// remaining loose ends with no retention at all:
//
//   - audit_logs                    : one row per admin/security action
//   - tenant_lifecycle_transitions  : one row per tenant state change;
//       FK onDelete cascade prunes the child tenant_lifecycle_hook_runs
//       (every transition dispatches multiple hooks + the 2-min retry
//       scheduler writes more for failed hooks)
//   - storage_operations            : storage-lifecycle op records
//   - provisioning_tasks            : per-tenant provisioning records
//
// The windows below were chosen 2026-06-01: 180 days for the audit
// trail (compliance baseline), 90 days for the operational tables.
//
// custom_deployment_image_audit was added after that sweep and had no
// retention either. It needs a DIFFERENT rule — see the note on
// IMAGE_AUDIT_RETENTION_DAYS: a plain age cutoff would silently re-break
// moving-tag update checks.

import { and, sql } from 'drizzle-orm';
import {
  auditLogs,
  tenantLifecycleTransitions,
  storageOperations,
  provisioningTasks,
  emailSendCounters,
  emailFblComplaints,
  deploymentUpgrades,
  platformStorageApplyRuns,
  drDrillRuns,
  imageReapLog,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';

// Audit trail — kept longest (compliance). Pure append-only log.
export const AUDIT_LOG_RETENTION_DAYS = 180;
// Operational records — short-lived; pruned at 90 days.
export const LIFECYCLE_TRANSITION_RETENTION_DAYS = 90;
export const STORAGE_OPERATION_RETENTION_DAYS = 90;
export const PROVISIONING_TASK_RETENTION_DAYS = 90;
// Send-accounting buckets (R6 PR 2) — 35 days so rolling 30-day
// complaint rates (R4) always have a full month of denominator.
export const EMAIL_SEND_COUNTER_RETENTION_DAYS = 35;
// FBL complaints (R4 PR 3) — 90 days covers any threshold review.
export const FBL_COMPLAINT_RETENTION_DAYS = 90;
/**
 * Image-audit history. NOT a plain age cutoff.
 *
 * The newest row per (deployment, image) is not history — it is the running
 * digest that `getRunningDigest` reads, and a moving-tag ("`:latest`") update
 * check returns "unknown" without it. A container that has been stable for a
 * year has exactly one row, older than any sane window; deleting it on age
 * would silently reintroduce the permanent-"unknown" bug this table exists to
 * prevent. So the prune keeps rank 1 per (deployment, image) FOREVER and only
 * removes superseded rows once they age out.
 */
export const IMAGE_AUDIT_RETENTION_DAYS = 90;
// Per-event operational history added after the 2026-06-01 sweep and missed by
// it (2026-09-03 re-audit). All four are pure per-event logs on a busy cluster:
// an upgrade attempt, an Apply HA/Local invocation, a DR drill, an image reap.
export const DEPLOYMENT_UPGRADE_RETENTION_DAYS = 90;
export const STORAGE_APPLY_RUN_RETENTION_DAYS = 90;
// DR drills are the evidence that restore actually works — kept as long as the
// audit trail rather than the 90d operational window.
export const DR_DRILL_RUN_RETENTION_DAYS = 180;
export const IMAGE_REAP_LOG_RETENTION_DAYS = 90;

/**
 * DELIBERATELY NOT PRUNED — read this before "finishing the sweep".
 *
 * `platform_upgrade_snapshots` looks like per-event history and is not: it is
 * the rollback manifest. `platform-ops rollback` reads the most recent
 * `captured` row to find the Flux ref and the Longhorn rescue snapshots to
 * restore from. A cluster that has been happily running one version for a year
 * has exactly one row, older than any sane window — an age cutoff would delete
 * the only thing standing between a bad upgrade and an unrecoverable cluster.
 *
 * Same shape of trap as IMAGE_AUDIT_RETENTION_DAYS above, with a worse blast
 * radius. If this ever does need bounding, it needs a keep-newest-N rule keyed
 * on status, never a plain `created_at <` cutoff.
 */

export interface DataRetentionResult {
  readonly auditLogs: number;
  /** Includes cascaded tenant_lifecycle_hook_runs (FK onDelete cascade). */
  readonly lifecycleTransitions: number;
  readonly storageOperations: number;
  readonly provisioningTasks: number;
  readonly emailSendCounters: number;
  readonly fblComplaints: number;
  /** Superseded image-audit rows. The newest per (deployment, image) is kept
   *  regardless of age — it is live state, not history. */
  readonly imageAuditRows: number;
  /** Terminal upgrade attempts only; an in-flight row is never touched. */
  readonly deploymentUpgrades: number;
  readonly storageApplyRuns: number;
  readonly drDrillRuns: number;
  readonly imageReapLogRows: number;
}

/**
 * Prune aged rows from the four unbounded tables. Idempotent and
 * boundedly cheap: each DELETE is a single indexed range scan on a
 * timestamp column (audit_logs/storage_operations/provisioning_tasks
 * by created_at, tenant_lifecycle_transitions by completed_at). All
 * cutoffs are evaluated DB-side via `NOW() - INTERVAL` so there is no
 * client-clock dependency.
 */
export async function runDataRetention(db: Database): Promise<DataRetentionResult> {
  // 1. audit_logs — pure append-only log, straight time-based prune.
  const audit = await db
    .delete(auditLogs)
    .where(
      sql`${auditLogs.createdAt} < NOW() - INTERVAL '${sql.raw(String(AUDIT_LOG_RETENTION_DAYS))} days'`,
    )
    .returning({ id: auditLogs.id });

  // 2. tenant_lifecycle_transitions — only TERMINAL rows (completed_at
  //    set; in-flight transitions have it NULL and are never touched).
  //    Deleting the parent cascades to tenant_lifecycle_hook_runs.
  const transitions = await db
    .delete(tenantLifecycleTransitions)
    .where(
      and(
        sql`${tenantLifecycleTransitions.completedAt} IS NOT NULL`,
        sql`${tenantLifecycleTransitions.completedAt} < NOW() - INTERVAL '${sql.raw(String(LIFECYCLE_TRANSITION_RETENTION_DAYS))} days'`,
      ),
    )
    .returning({ id: tenantLifecycleTransitions.id });

  // 3. storage_operations — no completed_at column; created_at-based.
  //    90 days >> any real operation duration, so an aged row is
  //    definitively terminal (no storage op runs for months).
  const storage = await db
    .delete(storageOperations)
    .where(
      sql`${storageOperations.createdAt} < NOW() - INTERVAL '${sql.raw(String(STORAGE_OPERATION_RETENTION_DAYS))} days'`,
    )
    .returning({ id: storageOperations.id });

  // 4. provisioning_tasks — terminal status only, so a genuinely stuck
  //    in-flight row is never deleted out from under a running provision.
  const provisioning = await db
    .delete(provisioningTasks)
    .where(
      and(
        sql`${provisioningTasks.status} IN ('completed','failed')`,
        sql`${provisioningTasks.createdAt} < NOW() - INTERVAL '${sql.raw(String(PROVISIONING_TASK_RETENTION_DAYS))} days'`,
      ),
    )
    .returning({ id: provisioningTasks.id });

  // 5. email_send_counters — hourly accounting buckets (R6 PR 2);
  //    aged buckets are pure history, never read after 35 days.
  const sendCounters = await db
    .delete(emailSendCounters)
    .where(
      sql`${emailSendCounters.bucketStart} < NOW() - INTERVAL '${sql.raw(String(EMAIL_SEND_COUNTER_RETENTION_DAYS))} days'`,
    )
    .returning({ bucketStart: emailSendCounters.bucketStart });

  // 6. email_fbl_complaints — complaint history (R4 PR 3).
  const complaints = await db
    .delete(emailFblComplaints)
    .where(
      sql`${emailFblComplaints.receivedAt} < NOW() - INTERVAL '${sql.raw(String(FBL_COMPLAINT_RETENTION_DAYS))} days'`,
    )
    .returning({ id: emailFblComplaints.id });

  // 7. custom_deployment_image_audit — one row per (deployment, digest), so a
  //    frequently-republished moving tag accumulates rows for the life of the
  //    deployment. The FK cascades on deployment delete, but nothing bounded it
  //    over time. Prune SUPERSEDED rows only: rank 1 per (deployment, image) is
  //    the running digest and must survive at any age (see the constant's note).
  const imageAudit = await db.execute(sql`
    DELETE FROM custom_deployment_image_audit a
     USING (
       SELECT id,
              row_number() OVER (
                PARTITION BY deployment_id, image
                ORDER BY pulled_at DESC, id DESC
              ) AS rn
         FROM custom_deployment_image_audit
     ) ranked
     WHERE a.id = ranked.id
       AND ranked.rn > 1
       AND a.pulled_at < NOW() - INTERVAL '${sql.raw(String(IMAGE_AUDIT_RETENTION_DAYS))} days'
  `);

  // 8. deployment_upgrades — TERMINAL statuses only. The EOL scanner reads
  //    this table to decide whether an upgrade is already in flight
  //    (`status IN ('pending','backing_up','pre_check','upgrading',
  //    'health_check','rolling_back')`); deleting a stuck in-flight row would
  //    make it start a SECOND upgrade of the same deployment.
  const upgrades = await db
    .delete(deploymentUpgrades)
    .where(
      and(
        sql`${deploymentUpgrades.status} IN ('completed','failed','rolled_back')`,
        sql`${deploymentUpgrades.createdAt} < NOW() - INTERVAL '${sql.raw(String(DEPLOYMENT_UPGRADE_RETENTION_DAYS))} days'`,
      ),
    )
    .returning({ id: deploymentUpgrades.id });

  // 9. platform_storage_apply_runs — one row per Apply HA / Apply Local
  //    invocation. `finished_at IS NOT NULL` is the terminal marker, so a run
  //    whose progress modal is still open is never deleted under it.
  const applyRuns = await db
    .delete(platformStorageApplyRuns)
    .where(
      and(
        sql`${platformStorageApplyRuns.finishedAt} IS NOT NULL`,
        sql`${platformStorageApplyRuns.finishedAt} < NOW() - INTERVAL '${sql.raw(String(STORAGE_APPLY_RUN_RETENTION_DAYS))} days'`,
      ),
    )
    .returning({ id: platformStorageApplyRuns.id });

  // 10. dr_drill_runs — drill execution history. The admin UI reads the most
  //     recent 12, so a 180-day window never empties a populated panel.
  const drills = await db
    .delete(drDrillRuns)
    .where(
      and(
        sql`${drDrillRuns.finishedAt} IS NOT NULL`,
        sql`${drDrillRuns.finishedAt} < NOW() - INTERVAL '${sql.raw(String(DR_DRILL_RUN_RETENTION_DAYS))} days'`,
      ),
    )
    .returning({ id: drDrillRuns.id });

  // 11. image_reap_log — pure per-reap log, nothing reads it as live state.
  const reapLog = await db
    .delete(imageReapLog)
    .where(
      sql`${imageReapLog.createdAt} < NOW() - INTERVAL '${sql.raw(String(IMAGE_REAP_LOG_RETENTION_DAYS))} days'`,
    )
    .returning({ id: imageReapLog.id });

  return {
    auditLogs: audit.length,
    lifecycleTransitions: transitions.length,
    storageOperations: storage.length,
    provisioningTasks: provisioning.length,
    emailSendCounters: sendCounters.length,
    fblComplaints: complaints.length,
    imageAuditRows: (imageAudit as unknown as { rowCount?: number }).rowCount ?? 0,
    deploymentUpgrades: upgrades.length,
    storageApplyRuns: applyRuns.length,
    drDrillRuns: drills.length,
    imageReapLogRows: reapLog.length,
  };
}
