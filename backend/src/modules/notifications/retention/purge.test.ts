import { describe, it, expect, vi } from 'vitest';
import { purgeOldDeliveries, purgeOldNotifications, runNotificationRetention, DELIVERY_RETENTION_DAYS, NOTIFICATION_RETENTION_DAYS, TEMPLATE_VERSION_RETENTION_DAYS, MAX_RETENTION_DAYS, type NotificationRetentionResult } from './purge.js';

type Db = Parameters<typeof purgeOldDeliveries>[0];

/** delete().where().returning() chain resolving to `rows`. */
function makeDeleteDb(rows: Array<{ id: string }>) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ returning });
  const del = vi.fn().mockReturnValue({ where });
  return { db: { delete: del } as unknown as Db, del, where };
}

describe('purgeOldDeliveries', () => {
  it('returns 0 immediately when retention <= 0', async () => {
    const db = {} as unknown as Db;
    expect(await purgeOldDeliveries(db, 0)).toBe(0);
  });

  it('deletes rows older than the cutoff and returns the count', async () => {
    const { db } = makeDeleteDb([{ id: '1' }, { id: '2' }, { id: '3' }]);
    expect(await purgeOldDeliveries(db, 30)).toBe(3);
  });
});

describe('purgeOldNotifications', () => {
  it('returns 0 immediately when retention <= 0', async () => {
    const db = {} as unknown as Db;
    expect(await purgeOldNotifications(db, 0)).toBe(0);
  });

  it('deletes rows older than the cutoff and returns the count', async () => {
    const { db } = makeDeleteDb([{ id: 'n1' }, { id: 'n2' }]);
    expect(await purgeOldNotifications(db, 90)).toBe(2);
  });

  it('defaults to a 90-day window', () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(90);
  });

  /**
   * The window must stay strictly wider than the delivery window.
   * Deliveries carry an FK to notifications with ON DELETE CASCADE, so a
   * notification window SHORTER than the delivery one would cascade-delete
   * delivery rows the delivery retention still considers live — silently
   * shrinking the audit trail to whatever the notification window is.
   */
  it('keeps notifications longer than their delivery rows', () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBeGreaterThan(DELIVERY_RETENTION_DAYS);
  });
});

describe('runNotificationRetention', () => {
  it('reports the rows removed from every table', async () => {
    const returning = vi.fn()
      .mockResolvedValueOnce([{ id: 'd1' }, { id: 'd2' }]) // deliveries
      .mockResolvedValueOnce([{ id: 'n1' }]); // notifications
    const where = vi.fn().mockReturnValue({ returning });
    const del = vi.fn().mockReturnValue({ where });
    const db = { delete: del } as unknown as Db;

    const r = await runNotificationRetention(db, { purgeBuckets: async () => 7 });
    expect(r).toEqual({ deliveries: 2, notifications: 1, buckets: 7, templateVersions: 0, expiredMutes: 0, digestItems: 0 });
  });

  /**
   * One failing table must not skip the others. A single try/catch around
   * all three would let a locked deliveries table stop the notifications
   * purge for as long as the lock lasts — the table that actually grows
   * unbounded would be the one that never gets pruned.
   */
  it('still purges the remaining tables when one throws', async () => {
    let call = 0;
    const del = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) throw new Error('deliveries locked');
      return { where: () => ({ returning: () => Promise.resolve([{ id: 'n1' }]) }) };
    });
    const db = { delete: del } as unknown as Db;

    const r = await runNotificationRetention(db, { purgeBuckets: async () => 0 });
    expect(r.deliveries).toBe(0);
    expect(r.notifications).toBe(1);
  });

  it('never throws when every table fails', async () => {
    const del = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const db = { delete: del } as unknown as Db;

    const r = await runNotificationRetention(db, {
      purgeBuckets: async () => { throw new Error('boom'); },
    });
    expect(r).toEqual({ deliveries: 0, notifications: 0, buckets: 0, templateVersions: 0, expiredMutes: 0, digestItems: 0 });
  });
});

describe('retention ceiling', () => {
  it('holds every window to MAX_RETENTION_DAYS or less', () => {
    // The operator's constraint: nothing in this domain may be kept longer
    // than 90 days. A new table with a generous window is exactly the kind
    // of change that passes review and grows a disk for a year.
    for (const [name, days] of Object.entries({
      DELIVERY_RETENTION_DAYS,
      NOTIFICATION_RETENTION_DAYS,
      TEMPLATE_VERSION_RETENTION_DAYS,
    })) {
      expect(days, `${name} exceeds the ceiling`).toBeLessThanOrEqual(MAX_RETENTION_DAYS);
      expect(days, `${name} must be a real window`).toBeGreaterThan(0);
    }
  });

  it('keeps the inbox window wider than the delivery window', () => {
    // deliveries.notification_id is ON DELETE CASCADE, so purging the inbox
    // first would truncate the audit trail early.
    expect(NOTIFICATION_RETENTION_DAYS).toBeGreaterThan(DELIVERY_RETENTION_DAYS);
  });

  it('reports every table it pruned, so a silent table cannot hide', () => {
    const result: NotificationRetentionResult = {
      deliveries: 0, notifications: 0, buckets: 0, templateVersions: 0, expiredMutes: 0,
      digestItems: 0,
    };
    // A table missing from this shape is a table whose growth is invisible
    // in the logs — which is how template_versions went unbounded.
    expect(Object.keys(result).sort()).toEqual(
      ['buckets', 'deliveries', 'digestItems', 'expiredMutes', 'notifications', 'templateVersions'],
    );
  });
});
