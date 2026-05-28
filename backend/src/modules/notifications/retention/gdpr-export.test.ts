import { describe, it, expect, vi } from 'vitest';
import { exportUserNotifications } from './gdpr-export.js';

type Db = Parameters<typeof exportUserNotifications>[0];

describe('exportUserNotifications', () => {
  it('returns notifications + deliveries sorted desc', async () => {
    const notifs = [
      {
        id: 'n1',
        userId: 'u1',
        type: 'info',
        title: 'T',
        message: 'M',
        categoryId: 'c.a',
        severity: 'info',
        eventId: 'e1',
        dedupeKey: null,
        locale: 'en',
        tenantId: null,
        isRead: 1,
        readAt: new Date('2026-01-02'),
        createdAt: new Date('2026-01-01'),
        resourceType: null,
        resourceId: null,
      },
    ];
    const deliveries = [
      {
        id: 'd1',
        notificationId: 'n1',
        eventId: 'e1',
        userId: 'u1',
        tenantId: null,
        categoryId: 'c.a',
        channel: 'in_app',
        providerId: null,
        recipientHash: 'rh',
        contentHash: 'ch',
        templateId: null,
        templateVersion: 0,
        locale: 'en',
        status: 'sent',
        attempt: 1,
        maxAttempts: 6,
        nextAttemptAt: null,
        lastError: null,
        providerMessageId: null,
        queuedAt: new Date('2026-01-01'),
        sentAt: new Date('2026-01-01'),
        deliveredAt: null,
        failedAt: null,
      },
    ];
    let call = 0;
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(call++ === 0 ? notifs : deliveries),
        }),
      }),
    }));
    const db = { select } as unknown as Db;
    const r = await exportUserNotifications(db, 'u1');
    expect(r.userId).toBe('u1');
    expect(r.notifications.length).toBe(1);
    expect(r.notifications[0].isRead).toBe(true);
    expect(r.deliveries.length).toBe(1);
    expect(r.deliveries[0].recipientHash).toBe('rh');
  });
});
