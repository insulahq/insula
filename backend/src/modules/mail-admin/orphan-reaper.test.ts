/**
 * orphan-reaper unit tests (2026-05-28).
 *
 * The reaper runs on platform-api startup and marks stale 'running'
 * mail.migration / mail.port-exposure rows + corresponding
 * mail_migration_runs as 'failed' so the next operator action isn't
 * blocked by an orphan task whose owning process is gone.
 */

import { describe, it, expect, vi } from 'vitest';
import { reapMailTaskOrphansOnBoot } from './orphan-reaper.js';

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

describe('reapMailTaskOrphansOnBoot', () => {
  it('runs lock + 2 UPDATEs inside a transaction; returns reaped counts from row data', async () => {
    const { tx } = buildTxMock([
      { rows: [] }, // lock
      { rows: [{ id: 't1' }, { id: 't2' }], rowCount: 2 }, // tasks
      { rows: [{ id: 'r1' }], rowCount: 1 }, // runs
    ]);
    const db = {
      transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as import('../../db/index.js').Database;

    const result = await reapMailTaskOrphansOnBoot(db);

    expect(tx.execute).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ tasksReaped: 2, runsReaped: 1 });
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

    const result = await reapMailTaskOrphansOnBoot(db);
    expect(result).toEqual({ tasksReaped: 0, runsReaped: 0 });
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

    const result = await reapMailTaskOrphansOnBoot(db);
    expect(result).toEqual({ tasksReaped: 3, runsReaped: 1 });
  });

  it('runs everything inside the same transaction (single db.transaction call)', async () => {
    const { tx } = buildTxMock([{ rows: [] }, { rows: [] }, { rows: [] }]);
    const db = {
      transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as import('../../db/index.js').Database;

    await reapMailTaskOrphansOnBoot(db);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
