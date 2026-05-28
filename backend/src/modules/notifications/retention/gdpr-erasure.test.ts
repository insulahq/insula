import { describe, it, expect, vi } from 'vitest';
import { eraseUserNotifications } from './gdpr-erasure.js';

type Db = Parameters<typeof eraseUserNotifications>[0];

describe('eraseUserNotifications', () => {
  it('deletes deliveries then notifications atomically and reports counts', async () => {
    let call = 0;
    const returning = vi.fn().mockImplementation(() => {
      return Promise.resolve(call++ === 0
        ? [{ id: 'd1' }, { id: 'd2' }]
        : [{ id: 'n1' }]);
    });
    const where = vi.fn().mockReturnValue({ returning });
    const del = vi.fn().mockReturnValue({ where });
    // The Drizzle transaction signature passes a tx with the same
    // method shape as the outer db — minimal fake just needs delete().
    const tx = { delete: del };
    const transaction = vi.fn().mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const db = { delete: del, transaction } as unknown as Db;
    const r = await eraseUserNotifications(db, 'u1');
    expect(r.deliveriesDeleted).toBe(2);
    expect(r.notificationsDeleted).toBe(1);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
