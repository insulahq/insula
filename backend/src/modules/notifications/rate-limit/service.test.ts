import { describe, it, expect, vi } from 'vitest';
import {
  incrementBucket,
  consumeRateLimit,
  purgeStaleBuckets,
  makeBucketKey,
  getBucketCount,
} from './service.js';

type Db = Parameters<typeof incrementBucket>[0];

describe('makeBucketKey', () => {
  it('rounds window-start down to the windowS boundary', () => {
    const now = new Date('2026-01-01T12:34:56Z');
    const k = makeBucketKey({ categoryId: 'c', userId: 'u', windowS: 3600, now });
    expect(k.bucketKey.startsWith('cat:c:user:u:win:')).toBe(true);
    const ts = Number.parseInt(k.bucketKey.split(':').pop() ?? '0', 10);
    expect(ts % 3600).toBe(0);
    expect(k.windowEnd.getTime() - k.windowStart.getTime()).toBe(3600 * 1000);
  });
});

describe('incrementBucket', () => {
  it('inserts on first hit and reports allowed', async () => {
    const returning = vi.fn().mockResolvedValue([{ count: 1 }]);
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as unknown as Db;

    const r = await incrementBucket(db, 'cat:c:user:u:win:1735660800', 3600, 5);
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
    expect(r.remaining).toBe(4);
  });

  it('returns allowed=false once count exceeds max', async () => {
    const returning = vi.fn().mockResolvedValue([{ count: 6 }]);
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as unknown as Db;

    const r = await incrementBucket(db, 'cat:c:user:u:win:1735660800', 3600, 5);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('allowed=true at exact max (count == max)', async () => {
    const returning = vi.fn().mockResolvedValue([{ count: 5 }]);
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as unknown as Db;

    const r = await incrementBucket(db, 'cat:c:user:u:win:1735660800', 3600, 5);
    expect(r.allowed).toBe(true);
  });
});

describe('consumeRateLimit', () => {
  it('builds the key then increments', async () => {
    const returning = vi.fn().mockResolvedValue([{ count: 1 }]);
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as unknown as Db;

    const r = await consumeRateLimit(db, {
      categoryId: 'security.suspicious_activity',
      userId: 'u1',
      windowS: 3600,
      max: 5,
    });
    expect(r.allowed).toBe(true);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      count: 1,
    }));
  });
});

describe('purgeStaleBuckets', () => {
  it('returns the count of deleted rows', async () => {
    const returning = vi.fn().mockResolvedValue([{ key: 'a' }, { key: 'b' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const del = vi.fn().mockReturnValue({ where });
    const db = { delete: del } as unknown as Db;
    const n = await purgeStaleBuckets(db);
    expect(n).toBe(2);
  });
});

describe('getBucketCount', () => {
  it('returns 0 when no row exists', async () => {
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    const db = { select } as unknown as Db;
    expect(await getBucketCount(db, 'k')).toBe(0);
  });
  it('returns the count when row exists', async () => {
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ count: 7 }]) }) }),
    });
    const db = { select } as unknown as Db;
    expect(await getBucketCount(db, 'k')).toBe(7);
  });
});
