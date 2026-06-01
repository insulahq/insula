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

import { and, sql } from 'drizzle-orm';
import {
  auditLogs,
  tenantLifecycleTransitions,
  storageOperations,
  provisioningTasks,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';

// Audit trail — kept longest (compliance). Pure append-only log.
export const AUDIT_LOG_RETENTION_DAYS = 180;
// Operational records — short-lived; pruned at 90 days.
export const LIFECYCLE_TRANSITION_RETENTION_DAYS = 90;
export const STORAGE_OPERATION_RETENTION_DAYS = 90;
export const PROVISIONING_TASK_RETENTION_DAYS = 90;

export interface DataRetentionResult {
  readonly auditLogs: number;
  /** Includes cascaded tenant_lifecycle_hook_runs (FK onDelete cascade). */
  readonly lifecycleTransitions: number;
  readonly storageOperations: number;
  readonly provisioningTasks: number;
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

  return {
    auditLogs: audit.length,
    lifecycleTransitions: transitions.length,
    storageOperations: storage.length,
    provisioningTasks: provisioning.length,
  };
}
