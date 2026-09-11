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
  CROWDSEC_AUTOBAN_RUN_RETENTION_DAYS,
  SFTP_AUDIT_LOG_RETENTION_DAYS,
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
  crowdsecAutobanRuns,
  sftpAuditLog,
  platformUpgradeSnapshots,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';

// Mock the Drizzle delete().where().returning() chain. Resolves each
// delete to the configured row array keyed by the table object identity,
// and records which tables delete() was invoked on + in what order.
function makeDb(rowsByTable: Map<unknown, Array<{ id: string }>>, imageAuditRowCount = 0) {
  const deletedTables: unknown[] = [];
  const executed: string[] = [];
  // The WHERE clause per table. Without capturing this, every assertion here
  // could only prove "we deleted from table X" — a dropped terminal-status
  // guard, or a typo'd status literal, would pass silently while the prune
  // became an unconditional age cutoff capable of deleting an IN-FLIGHT row.
  const conditions = new Map<unknown, string>();
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
        where: (cond: unknown) => {
          conditions.set(table, sqlTextOf(cond));
          return { returning: () => Promise.resolve(rowsByTable.get(table) ?? []) };
        },
      };
    },
  } as unknown as Database;
  return { db, deletedTables, executed, conditions };
}

/**
 * Flatten a Drizzle condition into searchable text.
 *
 * The tree is circular (columns reference their table), so it cannot be
 * JSON.stringify'd; walk it and collect the string chunks instead. That is
 * enough to assert which status literals and column names a guard mentions.
 */
function sqlTextOf(cond: unknown, depth = 0, out: string[] = []): string {
  if (depth > 10 || cond === null || cond === undefined) return out.join(' ');
  if (typeof cond === 'string') { out.push(cond); return out.join(' '); }
  if (typeof cond !== 'object') return out.join(' ');
  if (Array.isArray(cond)) {
    for (const c of cond) sqlTextOf(c, depth + 1, out);
    return out.join(' ');
  }
  for (const [k, v] of Object.entries(cond as Record<string, unknown>)) {
    if (k === 'table') continue; // the back-reference that makes this circular
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'object') sqlTextOf(v, depth + 1, out);
  }
  return out.join(' ');
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
        [crowdsecAutobanRuns, rows(9)],
        [sftpAuditLog, rows(4)],
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
      crowdsecAutobanRuns: 9,
      sftpAuditLogRows: 4,
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
      crowdsecAutobanRuns,
      sftpAuditLog,
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
      crowdsecAutobanRuns: 0,
      sftpAuditLogRows: 0,
    });
  });

  // Regression guards for the terminal-status filters. The EOL scanner treats
  // a deployment_upgrades row in a non-terminal status as "an upgrade is
  // already running"; deleting one would make it start a SECOND upgrade of the
  // same deployment. Before this, nothing in the suite could tell a correct
  // guard from no guard at all.
  it('prunes deployment_upgrades ONLY in terminal statuses', async () => {
    const { db, conditions } = makeDb(new Map());
    await runDataRetention(db);
    const where = conditions.get(deploymentUpgrades) ?? '';

    // Assert on the IN(...) list specifically. The flattened condition also
    // carries the COLUMN's enum definition (all nine statuses) and its
    // `pending` default, so a naive substring search over the whole tree would
    // match those rather than the filter.
    const inList = where.match(/IN \(([^)]*)\)/)?.[1] ?? '';
    expect(inList, 'no IN(...) status filter on deployment_upgrades').not.toBe('');

    const prunable = inList.split(',').map((v) => v.trim().replace(/'/g, ''));
    expect(prunable.sort()).toEqual(['completed', 'failed', 'rolled_back']);

    // Every in-flight status must be absent from the prunable set — including
    // one would let the prune delete a running upgrade.
    for (const inFlight of ['pending', 'backing_up', 'pre_check', 'upgrading', 'health_check', 'rolling_back']) {
      expect(prunable, `in-flight status ${inFlight} must not be prunable`).not.toContain(inFlight);
    }
  });

  it('prunes run tables only once they have finished', async () => {
    const { db, conditions } = makeDb(new Map());
    await runDataRetention(db);
    for (const table of [platformStorageApplyRuns, drDrillRuns]) {
      const where = conditions.get(table) ?? '';
      expect(where).toContain('finished_at');
      expect(where).toContain('IS NOT NULL');
    }
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

  // ── the two caps added 2026-09-11 ──
  //
  // Both tables were pruned by NOTHING anywhere in the codebase, found by a
  // production sweep. Neither is huge, but both are append-only, and
  // crowdsec_autoban_runs is bursty: one scanner burst wrote 1391 rows in a
  // single day (2026-09-06) against 3-23/day either side of it.

  it('prunes crowdsec_autoban_runs by triggered_at at 90 days', async () => {
    const { db, conditions } = makeDb(new Map([[crowdsecAutobanRuns, rows(3)]]));
    await runDataRetention(db);
    const cond = conditions.get(crowdsecAutobanRuns) ?? '';
    // The column matters: this table has NO created_at, so a copy-paste of
    // another prune would reference a column that does not exist.
    expect(cond).toContain('triggered_at');
    expect(cond).toContain(String(CROWDSEC_AUTOBAN_RUN_RETENTION_DAYS));
    expect(cond).toContain('NOW()');
  });

  it('prunes sftp_audit_log by created_at at 90 days', async () => {
    const { db, conditions } = makeDb(new Map([[sftpAuditLog, rows(2)]]));
    await runDataRetention(db);
    const cond = conditions.get(sftpAuditLog) ?? '';
    expect(cond).toContain('created_at');
    expect(cond).toContain(String(SFTP_AUDIT_LOG_RETENTION_DAYS));
    // sftp_audit_log.created_at is timestamp WITHOUT time zone, unlike most
    // tables here. The cutoff must stay DB-side so that cannot matter.
    expect(cond).toContain('NOW()');
  });

  it('keeps both caps at 90 days', () => {
    expect(CROWDSEC_AUTOBAN_RUN_RETENTION_DAYS).toBe(90);
    expect(SFTP_AUDIT_LOG_RETENTION_DAYS).toBe(90);
  });
});
