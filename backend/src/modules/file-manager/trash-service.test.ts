import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_TRASH_RETENTION_DAYS } from '@insula/api-contracts';
import { getTrashRetentionDays, __resetOpportunisticSweepForTests, sweepTrashOpportunistically } from './trash-service.js';
import type { Database } from '../../db/index.js';

/**
 * Retention is multiplied into a purge cutoff, so every path that could yield 0
 * or NaN is a path that silently empties every tenant's recycle bin on the next
 * sweep. These tests pin the fallback rather than the happy path.
 */

function dbReturning(rows: unknown[]): Database {
  return {
    select: () => ({ from: () => ({ limit: () => Promise.resolve(rows) }) }),
  } as unknown as Database;
}

describe('getTrashRetentionDays', () => {
  it('returns the configured value', async () => {
    await expect(getTrashRetentionDays(dbReturning([{ days: 30 }]))).resolves.toBe(30);
  });

  it('falls back to the default when no settings row exists', async () => {
    await expect(getTrashRetentionDays(dbReturning([]))).resolves.toBe(DEFAULT_TRASH_RETENTION_DAYS);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['non-numeric', 'soon'],
    ['above the maximum', 100_000],
  ])('falls back to the default for %s rather than expiring everything', async (_label, value) => {
    const days = await getTrashRetentionDays(dbReturning([{ days: value }]));
    expect(days).toBe(DEFAULT_TRASH_RETENTION_DAYS);
    // The real assertion: never a cutoff of "now" or later.
    expect(days).toBeGreaterThan(0);
  });

  it('floors a fractional value instead of producing a fractional cutoff', async () => {
    await expect(getTrashRetentionDays(dbReturning([{ days: 14.9 }]))).resolves.toBe(14);
  });
});

describe('sweepTrashOpportunistically', () => {
  beforeEach(() => {
    __resetOpportunisticSweepForTests();
    vi.restoreAllMocks();
  });

  it('is throttled per namespace so ordinary file traffic does not sweep on every click', async () => {
    // Counting reads of the retention setting is a proxy for "the sweep body
    // ran": the gate is checked before anything else happens.
    const select = vi.fn(() => ({ from: () => ({ limit: () => Promise.resolve([{ days: 14 }]) }) }));
    const db = { select } as unknown as Database;

    sweepTrashOpportunistically(db, {} as never, undefined, 'tenant-a-1234');
    sweepTrashOpportunistically(db, {} as never, undefined, 'tenant-a-1234');
    sweepTrashOpportunistically(db, {} as never, undefined, 'tenant-a-1234');
    await new Promise((r) => setTimeout(r, 20));

    // The stamp is taken BEFORE the first await, so three synchronous calls
    // cannot all slip through the gate.
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('throttles each namespace independently', async () => {
    const select = vi.fn(() => ({ from: () => ({ limit: () => Promise.resolve([{ days: 14 }]) }) }));
    const db = { select } as unknown as Database;

    sweepTrashOpportunistically(db, {} as never, undefined, 'tenant-a-1234');
    sweepTrashOpportunistically(db, {} as never, undefined, 'tenant-b-5678');
    await new Promise((r) => setTimeout(r, 20));

    expect(select).toHaveBeenCalledTimes(2);
  });

  it('un-stamps after a failure so the next request retries instead of waiting out the hour', async () => {
    let calls = 0;
    const select = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return { from: () => ({ limit: () => Promise.resolve([{ days: 14 }]) }) };
    });
    const db = { select } as unknown as Database;

    sweepTrashOpportunistically(db, {} as never, undefined, 'tenant-c-9999');
    await new Promise((r) => setTimeout(r, 20));
    sweepTrashOpportunistically(db, {} as never, undefined, 'tenant-c-9999');
    await new Promise((r) => setTimeout(r, 20));

    expect(select).toHaveBeenCalledTimes(2);
  });

  it('never throws into the caller when the sweep fails', () => {
    const db = {
      select: () => { throw new Error('db down'); },
    } as unknown as Database;
    expect(() => sweepTrashOpportunistically(db, {} as never, undefined, 'tenant-b-5678')).not.toThrow();
  });
});
