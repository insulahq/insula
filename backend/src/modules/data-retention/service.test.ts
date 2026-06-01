import { describe, it, expect } from 'vitest';
import {
  runDataRetention,
  AUDIT_LOG_RETENTION_DAYS,
  LIFECYCLE_TRANSITION_RETENTION_DAYS,
  STORAGE_OPERATION_RETENTION_DAYS,
  PROVISIONING_TASK_RETENTION_DAYS,
} from './service.js';
import {
  auditLogs,
  tenantLifecycleTransitions,
  storageOperations,
  provisioningTasks,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';

// Mock the Drizzle delete().where().returning() chain. Resolves each
// delete to the configured row array keyed by the table object identity,
// and records which tables delete() was invoked on + in what order.
function makeDb(rowsByTable: Map<unknown, Array<{ id: string }>>) {
  const deletedTables: unknown[] = [];
  const db = {
    delete: (table: unknown) => {
      deletedTables.push(table);
      return {
        where: (_cond: unknown) => ({
          returning: () => Promise.resolve(rowsByTable.get(table) ?? []),
        }),
      };
    },
  } as unknown as Database;
  return { db, deletedTables };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

describe('data-retention runDataRetention', () => {
  it('prunes all four unbounded tables and reports per-table counts', async () => {
    const { db, deletedTables } = makeDb(
      new Map<unknown, Array<{ id: string }>>([
        [auditLogs, rows(5)],
        [tenantLifecycleTransitions, rows(3)],
        [storageOperations, rows(2)],
        [provisioningTasks, rows(1)],
      ]),
    );

    const result = await runDataRetention(db);

    expect(result).toEqual({
      auditLogs: 5,
      lifecycleTransitions: 3,
      storageOperations: 2,
      provisioningTasks: 1,
    });
    // Exactly the four target tables, each deleted once.
    expect(deletedTables).toEqual([
      auditLogs,
      tenantLifecycleTransitions,
      storageOperations,
      provisioningTasks,
    ]);
  });

  it('reports zeros when nothing is old enough to prune', async () => {
    const { db } = makeDb(new Map());
    const result = await runDataRetention(db);
    expect(result).toEqual({
      auditLogs: 0,
      lifecycleTransitions: 0,
      storageOperations: 0,
      provisioningTasks: 0,
    });
  });

  it('keeps the chosen retention windows (audit 180d, operational 90d)', () => {
    expect(AUDIT_LOG_RETENTION_DAYS).toBe(180);
    expect(LIFECYCLE_TRANSITION_RETENTION_DAYS).toBe(90);
    expect(STORAGE_OPERATION_RETENTION_DAYS).toBe(90);
    expect(PROVISIONING_TASK_RETENTION_DAYS).toBe(90);
  });
});
