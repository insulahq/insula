import { describe, it, expect, vi } from 'vitest';
import { purgeOldDeliveries, purgeOldDeliveriesSafe } from './purge.js';

type Db = Parameters<typeof purgeOldDeliveries>[0];

describe('purgeOldDeliveries', () => {
  it('returns 0 immediately when retention <= 0', async () => {
    const db = {} as unknown as Db;
    expect(await purgeOldDeliveries(db, 0)).toBe(0);
  });

  it('deletes rows older than the cutoff and returns the count', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: '1' }, { id: '2' }, { id: '3' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const del = vi.fn().mockReturnValue({ where });
    const db = { delete: del } as unknown as Db;
    expect(await purgeOldDeliveries(db, 30)).toBe(3);
  });
});

describe('purgeOldDeliveriesSafe', () => {
  it('returns 0 when underlying delete throws', async () => {
    const del = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const db = { delete: del } as unknown as Db;
    expect(await purgeOldDeliveriesSafe(db)).toBe(0);
  });
});
