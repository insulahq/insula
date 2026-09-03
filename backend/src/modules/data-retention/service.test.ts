import { describe, it, expect } from 'vitest';
import {
  runDataRetention,
  AUDIT_LOG_RETENTION_DAYS,
  LIFECYCLE_TRANSITION_RETENTION_DAYS,
  STORAGE_OPERATION_RETENTION_DAYS,
  PROVISIONING_TASK_RETENTION_DAYS,
  DEPLOYMENT_UPGRADE_RETENTION_DAYS,
  STORAGE_APPLY_RUN_RETENTION_DAYS,
  DR_DRILL_RUN_RETENTION_DAYS,
  IMAGE_REAP_LOG_RETENTION_DAYS,
} from './service.js';
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
  platformUpgradeSnapshots,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';

// Mock the Drizzle delete().where().returning() chain. Resolves each
// delete to the configured row array keyed by the table object identity,
// and records which tables delete() was invoked on + in what order.
function makeDb(rowsByTable: Map<unknown, Array<{ id: string }>>, imageAuditRowCount = 0) {
  const deletedTables: unknown[] = [];
  const executed: string[] = [];
  const db = {
    // custom_deployment_image_audit is pruned with raw SQL — a window function
    // is needed to keep rank 1 per (deployment, image), which the Drizzle
    // delete() builder cannot express.
    execute: (q: unknown) => {
      executed.push(String((q as { queryChunks?: unknown }).queryChunks ?? q));
      return Promise.resolve({ rowCount: imageAuditRowCount });
    },
    delete: (table: unknown) => {
      deletedTables.push(table);
      return {
        where: (_cond: unknown) => ({
          returning: () => Promise.resolve(rowsByTable.get(table) ?? []),
        }),
      };
    },
  } as unknown as Database;
  return { db, deletedTables, executed };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

describe('data-retention runDataRetention', () => {
  it('prunes every unbounded table and reports per-table counts', async () => {
    const { db, deletedTables } = makeDb(
      new Map<unknown, Array<{ id: string }>>([
        [auditLogs, rows(5)],
        [tenantLifecycleTransitions, rows(3)],
        [storageOperations, rows(2)],
        [provisioningTasks, rows(1)],
        [emailSendCounters, rows(4)],
        [emailFblComplaints, rows(2)],
        [deploymentUpgrades, rows(7)],
        [platformStorageApplyRuns, rows(3)],
        [drDrillRuns, rows(1)],
        [imageReapLog, rows(6)],
      ]),
    );

    const result = await runDataRetention(db);

    expect(result).toEqual({
      auditLogs: 5,
      lifecycleTransitions: 3,
      storageOperations: 2,
      provisioningTasks: 1,
      emailSendCounters: 4,
      fblComplaints: 2,
      imageAuditRows: 0,
      deploymentUpgrades: 7,
      storageApplyRuns: 3,
      drDrillRuns: 1,
      imageReapLogRows: 6,
    });
    // Exactly the target tables, each deleted once.
    expect(deletedTables).toEqual([
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
    ]);
  });

  // platform_upgrade_snapshots is the rollback manifest, not history:
  // `platform-ops rollback` reads the most recent captured row, and a cluster
  // stable on one version for a year has exactly one row older than any
  // window. Age-pruning it would delete the only path back from a bad upgrade.
  it('NEVER prunes platform_upgrade_snapshots — it is rollback state', async () => {
    const { db, deletedTables } = makeDb(new Map());
    await runDataRetention(db);
    expect(deletedTables).not.toContain(platformUpgradeSnapshots);
  });

  it('reports zeros when nothing is old enough to prune', async () => {
    const { db } = makeDb(new Map());
    const result = await runDataRetention(db);
    expect(result).toEqual({
      auditLogs: 0,
      lifecycleTransitions: 0,
      storageOperations: 0,
      provisioningTasks: 0,
      emailSendCounters: 0,
      fblComplaints: 0,
      imageAuditRows: 0,
      deploymentUpgrades: 0,
      storageApplyRuns: 0,
      drDrillRuns: 0,
      imageReapLogRows: 0,
    });
  });

  it('keeps the chosen retention windows (audit 180d, operational 90d)', () => {
    expect(AUDIT_LOG_RETENTION_DAYS).toBe(180);
    expect(LIFECYCLE_TRANSITION_RETENTION_DAYS).toBe(90);
    expect(STORAGE_OPERATION_RETENTION_DAYS).toBe(90);
    expect(PROVISIONING_TASK_RETENTION_DAYS).toBe(90);
    expect(DEPLOYMENT_UPGRADE_RETENTION_DAYS).toBe(90);
    expect(STORAGE_APPLY_RUN_RETENTION_DAYS).toBe(90);
    expect(IMAGE_REAP_LOG_RETENTION_DAYS).toBe(90);
    // DR drills are restore evidence — kept as long as the audit trail.
    expect(DR_DRILL_RUN_RETENTION_DAYS).toBe(180);
  });
});
