/**
 * Per-domain sending today against a real Postgres, with a fixed clock: the
 * current UTC hour and day per domain, the busiest domain (never a sum), the
 * limits holding mail back now, and the per-domain 80%/100% dedupe key that
 * migration 0183 introduced.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant, seedDomain } from '../../test-helpers/fixtures.js';
import { emailSendCounters, emailDomains, emailQuotaEvents } from '../../db/schema.js';
import { readDomainUsage, getTenantMailToday } from './domain-usage.js';
import { getTenantMailUsage } from './usage.js';
import { getTenantMailDomainStats } from './domain-stats.js';

const dbAvailable = await isDbAvailable();
// 14:56 UTC: the daily limit was reached at 14:09 and mail is held until midnight.
const NOW = new Date('2026-11-16T14:56:40Z');

describe.skipIf(!dbAvailable)('per-domain sending today (integration)', () => {
  const db = () => getTestDb();
  let tenantId = '';
  let shopEmailDomainId = '';

  beforeAll(async () => {
    await runMigrations();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  async function counter(domain: string, at: string, c: {
    sent?: number; held?: number; heldDaily?: number; refused?: number;
  }) {
    await db().insert(emailSendCounters).values({
      tenantId, domain, bucketStart: new Date(at),
      sentCount: c.sent ?? 0, recipientCount: c.sent ?? 0,
      rateLimitedCount: c.held ?? 0, rateLimitedDailyCount: c.heldDaily ?? 0,
      quotaRejectedCount: c.refused ?? 0,
    });
  }

  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE email_send_counters, email_quota_events CASCADE'));
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db(), { emailHourlySendLimit: 50, emailDailySendLimit: 100 })).id;
    tenantId = (await seedTenant(db(), regionId, planId)).id;
    const shop = await seedDomain(db(), tenantId, { domainName: 'shop.example.test' });
    shopEmailDomainId = crypto.randomUUID();
    await db().insert(emailDomains).values({ id: shopEmailDomainId, domainId: shop.id, tenantId } as typeof emailDomains.$inferInsert);

    // shop: 91 before 14:00, then 10 in the 14:00 hour of which 9 were held by
    // the daily window. An hourly hold at 09:00 was released at 10:00.
    await counter('shop.example.test', '2026-11-16T09:00:00Z', { sent: 50, held: 2 });
    await counter('shop.example.test', '2026-11-16T13:00:00Z', { sent: 41 });
    await counter('SHOP.example.test', '2026-11-16T14:00:00Z', { sent: 10, held: 9, heldDaily: 9 });
    // news: well within its own limit; the two together are over 100.
    await counter('news.example.test', '2026-11-16T14:00:00Z', { sent: 10 });
    // yesterday does not count today
    await counter('shop.example.test', '2026-11-15T23:00:00Z', { sent: 500, held: 400, heldDaily: 400 });
  });

  it('groups the current hour and UTC day per domain, case-insensitively', async () => {
    const rows = await readDomainUsage(db(), { tenantId, now: NOW });
    const shop = rows.find((r) => r.domain === 'shop.example.test');
    expect(shop).toMatchObject({
      sentThisHour: 10, sentToday: 101, heldThisHourHourly: 0, heldTodayDaily: 9, heldToday: 11,
    });
    expect(rows.find((r) => r.domain === 'news.example.test')).toMatchObject({ sentToday: 10 });
  });

  it('reports the busiest domain against the limit, and the held mail with its release', async () => {
    const usage = await getTenantMailUsage(db(), tenantId, NOW);
    expect(usage.day).toMatchObject({ used: 101, limit: 100, domain: 'shop.example.test', rateLimited: 11 });
    expect(usage.domains.map((d) => d.domain)).toEqual(['shop.example.test', 'news.example.test']);
    expect(usage.throttles).toEqual([expect.objectContaining({
      domain: 'shop.example.test', emailDomainId: shopEmailDomainId, window: 'day', heldNow: 9,
      releasesAt: '2026-11-17T00:00:00.000Z', refusing: false,
    })]);

    const today = await getTenantMailToday(db(), tenantId, NOW);
    expect(today.throttles).toHaveLength(1);
  });

  it('puts today and the throttle on the domain statistics', async () => {
    const stats = await getTenantMailDomainStats(db(), tenantId, NOW);
    expect(stats).toMatchObject({ hourlyLimit: 50, dailyLimit: 100, outboundSuspended: false });
    const shop = stats.domains.find((d) => d.domain === 'shop.example.test');
    expect(shop).toMatchObject({ sentToday: 101, sentThisHour: 10, throttle: { heldNow: 9, window: 'day' } });
  });

  // Migration 0183: the first domain to cross no longer uses up the day's alert
  // for the tenant's other domains.
  it('dedupes threshold crossings per domain', async () => {
    const row = (domain: string) => ({
      tenantId, domain, windowKind: 'day', threshold: 100, windowStart: new Date('2026-11-16T00:00:00Z'),
    });
    const first = await db().insert(emailQuotaEvents).values(row('shop.example.test')).onConflictDoNothing().returning();
    const again = await db().insert(emailQuotaEvents).values(row('shop.example.test')).onConflictDoNothing().returning();
    const other = await db().insert(emailQuotaEvents).values(row('news.example.test')).onConflictDoNothing().returning();
    expect([first.length, again.length, other.length]).toEqual([1, 0, 1]);
  });
});
