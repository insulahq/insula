/**
 * A category's rate limit against a real Postgres, through the dispatcher.
 *
 * "WAL archiving failing" allows one alert per 6 hours. Production's alert
 * reached the panel and the push topic and was recorded `rate_limited` for
 * email: the in-app leg had taken the only slot, because the bucket key named
 * no channel. Each channel now has its own budget.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { getTestDb, isDbAvailable, runMigrations } from '../../../test-helpers/db.js';
import { notificationDeliveries, notificationRateLimitBuckets, notifications, users } from '../../../db/schema.js';
import { seedCategoriesIfMissing } from '../categories/service.js';
import { seedTemplatesIfMissing } from '../templates/seed-loader.js';
import { emitEvent } from '../dispatcher/dispatch.js';

const skipIntegration = !await isDbAvailable();

describe.skipIf(skipIntegration)('rate limit per channel (integration)', () => {
  const uid = crypto.randomUUID().slice(0, 8);
  const adminId = crypto.randomUUID();
  let db: ReturnType<typeof getTestDb>;

  const alert = async (failingSince: string) => {
    const r = await emitEvent(db, {
      categoryId: 'admin.wal_archive_failing',
      scope: { kind: 'admin' },
      variables: { clusterName: 'system-db', pressurePercent: '14' },
      dedupeKey: `wal-failing:system-db:${uid}:${failingSince}`,
      encryptionKey: 'test-key',
    });
    return Object.fromEntries(r.perChannelStatuses.filter((s) => s.userId === adminId).map((s) => [s.channel, s.status]));
  };

  beforeAll(async () => {
    await runMigrations();
    db = getTestDb();
    await seedCategoriesIfMissing(db);
    await seedTemplatesIfMissing(db);
    await db.insert(users).values({
      id: adminId, email: `a-${uid}@example.test`, passwordHash: 'x', fullName: 'A', roleName: 'admin', panel: 'admin', status: 'active',
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(notificationDeliveries).where(eq(notificationDeliveries.userId, adminId));
    await db.delete(notifications).where(eq(notifications.userId, adminId));
    await db.delete(notificationRateLimitBuckets).where(like(notificationRateLimitBuckets.bucketKey, `%:user:${adminId}:%`));
    await db.delete(users).where(eq(users.id, adminId));
  });

  it('lets one alert through on in-app AND email, then holds the next on both', async () => {
    const first = await alert('2026-11-03T16:30:45Z');
    expect(first.in_app).toBe('sent');
    expect(first.email).toBeDefined();
    expect(first.email).not.toBe('rate_limited');

    const second = await alert('2026-11-03T17:30:00Z');
    expect(second).toMatchObject({ in_app: 'rate_limited', email: 'rate_limited' });
  });
});
