/**
 * The admin tenant page's mail chart, against a real Postgres: one row per
 * UTC day over the window, oldest first, zero days kept, every domain of the
 * tenant summed, and another tenant's mail never counted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { buildTestApp, generateToken } from '../../test-helpers/app.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { emailSendCounters } from '../../db/schema.js';
import { getTenantMailDaily } from './daily.js';

const dbAvailable = await isDbAvailable();
const NOW = new Date('2026-10-19T14:10:00Z');

describe.skipIf(!dbAvailable)('tenant mail per day (integration)', () => {
  const db = () => getTestDb();
  let app: FastifyInstance;
  let tenantId = '';
  let otherTenantId = '';

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  async function sent(owner: string, domain: string, at: string, counts: { sent: number; rcpt?: number; deferred?: number; rejected?: number }) {
    await db().insert(emailSendCounters).values({
      tenantId: owner, domain, bucketStart: new Date(at),
      sentCount: counts.sent, recipientCount: counts.rcpt ?? counts.sent,
      rateLimitedCount: counts.deferred ?? 0, quotaRejectedCount: counts.rejected ?? 0,
    });
  }

  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE email_send_counters CASCADE'));
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    tenantId = (await seedTenant(db(), regionId, planId)).id;
    otherTenantId = (await seedTenant(db(), regionId, planId)).id;
    await sent(tenantId, 'shop.example.test', '2026-10-19T09:00:00Z', { sent: 2, rcpt: 3 });
    await sent(tenantId, 'shop.example.test', '2026-10-18T23:00:00Z', { sent: 5, deferred: 1 });
    await sent(tenantId, 'blog.example.test', '2026-10-18T01:00:00Z', { sent: 4, rejected: 2 });
    await sent(tenantId, 'shop.example.test', '2026-10-06T00:00:00Z', { sent: 7 }); // first day of the window
    await sent(tenantId, 'shop.example.test', '2026-10-05T23:00:00Z', { sent: 1000 }); // the day before it
    await sent(otherTenantId, 'other.example.test', '2026-10-19T10:00:00Z', { sent: 50 });
  });

  it('returns fourteen UTC days, oldest first, with every domain summed and empty days as zeros', async () => {
    const { days } = await getTenantMailDaily(db(), tenantId, 14, NOW);
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ date: '2026-10-06', sent: 7, recipients: 7, rateLimited: 0, quotaRejected: 0 });
    expect(days[1]).toEqual({ date: '2026-10-07', sent: 0, recipients: 0, rateLimited: 0, quotaRejected: 0 });
    expect(days[12]).toEqual({ date: '2026-10-18', sent: 9, recipients: 9, rateLimited: 1, quotaRejected: 2 });
    expect(days[13]).toEqual({ date: '2026-10-19', sent: 2, recipients: 3, rateLimited: 0, quotaRejected: 0 });
  });

  it('serves an admin any tenant and refuses a tenant user another tenant’s days', async () => {
    const admin = generateToken(app, { role: 'admin', panel: 'admin' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/tenants/${tenantId}/mail/daily`, headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { days: unknown[] } }).data.days).toHaveLength(14);

    const own = generateToken(app, { role: 'tenant_user', panel: 'tenant', tenantId });
    const other = await app.inject({ method: 'GET', url: `/api/v1/tenants/${otherTenantId}/mail/daily`, headers: { authorization: `Bearer ${own}` } });
    expect(other.statusCode).toBe(403);
  });
});
