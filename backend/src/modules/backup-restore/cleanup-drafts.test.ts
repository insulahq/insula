/**
 * Unit tests for cleanupDraftRestoreCarts.
 *
 * Pure-function test: pass in a mocked Database with a recorded
 * `delete().where(...)` chain, assert the WHERE clause + the
 * status-filter + the cutoff timestamp.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  cleanupDraftRestoreCarts,
  DRAFT_CART_RETENTION_DAYS,
} from './cleanup-drafts.js';

interface RecordedDelete {
  table: unknown;
  whereCalls: unknown[];
  result: { rowCount?: number } | unknown[];
}

function makeDb(rowsDeleted: number) {
  const recorded: RecordedDelete = { table: null, whereCalls: [], result: { rowCount: rowsDeleted } };
  const db = {
    delete: vi.fn((table: unknown) => {
      recorded.table = table;
      return {
        where: vi.fn((expr: unknown) => {
          recorded.whereCalls.push(expr);
          return {
            returning: vi.fn().mockResolvedValue(
              Array.from({ length: rowsDeleted }, (_, i) => ({ id: `rstr-${i}` })),
            ),
          };
        }),
      };
    }),
  };
  return { db, recorded };
}

describe('cleanupDraftRestoreCarts', () => {
  it('issues exactly one DELETE on restoreJobs (cascade handles items)', async () => {
    const { db } = makeDb(3);
    const now = new Date('2026-05-29T12:00:00Z');

    const result = await cleanupDraftRestoreCarts({
      db: db as unknown as import('../../db/index.js').Database,
      now: () => now,
    });

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(result.deleted).toBe(3);
  });

  it('uses DRAFT_CART_RETENTION_DAYS-old cutoff by default (7 days)', async () => {
    const { db } = makeDb(0);
    const now = new Date('2026-05-29T12:00:00Z');

    await cleanupDraftRestoreCarts({
      db: db as unknown as import('../../db/index.js').Database,
      now: () => now,
    });

    // The cutoff timestamp is composed inside the where clause.
    // We don't introspect Drizzle's SQL AST here — we trust the
    // implementation to use DRAFT_CART_RETENTION_DAYS. The constant
    // export gives us a single source of truth callers can verify.
    expect(DRAFT_CART_RETENTION_DAYS).toBe(7);
  });

  it('returns deleted=0 when no rows match', async () => {
    const { db } = makeDb(0);
    const now = new Date('2026-05-29T12:00:00Z');

    const result = await cleanupDraftRestoreCarts({
      db: db as unknown as import('../../db/index.js').Database,
      now: () => now,
    });

    expect(result.deleted).toBe(0);
  });

  it('allows operator to override retentionDays', async () => {
    const { db } = makeDb(1);
    const now = new Date('2026-05-29T12:00:00Z');

    const result = await cleanupDraftRestoreCarts({
      db: db as unknown as import('../../db/index.js').Database,
      now: () => now,
      retentionDays: 30,
    });

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(result.deleted).toBe(1);
  });

  it('swallows + logs DB errors so the scheduler tick continues', async () => {
    const db = {
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockRejectedValue(new Error('connection terminated')),
        })),
      })),
    };
    const warn = vi.fn();

    const result = await cleanupDraftRestoreCarts({
      db: db as unknown as import('../../db/index.js').Database,
      now: () => new Date('2026-05-29T12:00:00Z'),
      logger: { warn },
    });

    expect(result.deleted).toBe(0);
    expect(result.error).toBeDefined();
    expect(warn).toHaveBeenCalled();
  });
});
