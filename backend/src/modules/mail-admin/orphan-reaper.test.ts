/**
 * orphan-reaper unit tests.
 *
 * The reaper (start-up + periodic) marks 'running' mail.migration /
 * mail.port-exposure rows + mail_migration_runs whose owner is gone (no live
 * liveness lease) as 'failed', and drops expired leases. The SQL semantics are
 * covered against a real Postgres in orphan-reaper.integration.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { reapMailTaskOrphans } from './orphan-reaper.js';

function buildTxMock(results: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const calls: Array<{ idx: number }> = [];
  let idx = 0;
  const tx = {
    execute: vi.fn(async () => {
      const r = results[idx] ?? { rows: [], rowCount: 0 };
      calls.push({ idx });
      idx++;
      return r;
    }),
  };
  return { tx, calls };
}

describe('reapMailTaskOrphans', () => {
  it('runs lock + 2 UPDATEs + lease cleanup inside a transaction; returns counts from row data', async () => {
    const { tx } = buildTxMock([
      { rows: [] }, // lock
      { rows: [{ id: 't1' }, { id: 't2' }], rowCount: 2 }, // tasks
      { rows: [{ id: 'r1' }], rowCount: 1 }, // runs
      { rows: [{ setting_key: 'k' }], rowCount: 1 }, // expired leases
    ]);
    const db = {
      transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as import('../../db/index.js').Database;

    const result = await reapMailTaskOrphans(db);

    expect(tx.execute).toHaveBeenCalledTimes(4);
    expect(result).toEqual({ tasksReaped: 2, runsReaped: 1, leasesDropped: 1 });
  });

  it('reports zero counts when no orphan rows exist', async () => {
    const { tx } = buildTxMock([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const db = {
      transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as import('../../db/index.js').Database;

    const result = await reapMailTaskOrphans(db);
    expect(result).toEqual({ tasksReaped: 0, runsReaped: 0, leasesDropped: 0 });
  });

  it('falls back to rows.length when rowCount is undefined (drizzle node-postgres adapter quirk)', async () => {
    const { tx } = buildTxMock([
      { rows: [] },
      { rows: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] }, // rowCount undefined
      { rows: [{ id: 'r1' }] },
    ]);
    const db = {
      transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as import('../../db/index.js').Database;

    const result = await reapMailTaskOrphans(db);
    expect(result).toEqual({ tasksReaped: 3, runsReaped: 1, leasesDropped: 0 });
  });

  it('runs everything inside the same transaction (single db.transaction call)', async () => {
    const { tx } = buildTxMock([{ rows: [] }, { rows: [] }, { rows: [] }]);
    const db = {
      transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as import('../../db/index.js').Database;

    await reapMailTaskOrphans(db);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
