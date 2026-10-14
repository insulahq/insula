/**
 * Email → Statistics, against a real Postgres: one tenant's send figures per
 * domain, every email domain listed (zero included), a sending-only domain
 * marked as such, the 24-hour and 7-day windows kept apart, and another
 * tenant's mail never counted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { buildTestApp, generateToken } from '../../test-helpers/app.js';
import { seedRegion, seedPlan, seedTenant, seedDomain } from '../../test-helpers/fixtures.js';
import { emailDomains, emailSendCounters } from '../../db/schema.js';
import { getTenantMailDomainStats } from './domain-stats.js';

const dbAvailable = await isDbAvailable();
const HOUR = 3_600_000;

describe.skipIf(!dbAvailable)('tenant mail statistics per domain (integration)', () => {
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

  async function hostEmail(owner: string, name: string) {
    const d = await seedDomain(db(), owner, { domainName: name });
    await db().insert(emailDomains).values({ id: crypto.randomUUID(), domainId: d.id, tenantId: owner } as typeof emailDomains.$inferInsert);
  }

  async function sent(owner: string, domain: string, hoursAgo: number, counts: { sent: number; rcpt?: number; deferred?: number; rejected?: number }) {
    await db().insert(emailSendCounters).values({
      tenantId: owner, domain, bucketStart: new Date(Math.floor((Date.now() - hoursAgo * HOUR) / HOUR) * HOUR),
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
    await hostEmail(tenantId, 'shop.example.test');
    await hostEmail(tenantId, 'quiet.example.test');
    await hostEmail(otherTenantId, 'other.example.test');
    await sent(tenantId, 'shop.example.test', 2, { sent: 5, rcpt: 9, deferred: 1 });
    await sent(tenantId, 'SHOP.example.test', 30, { sent: 7, rejected: 2 });
    await sent(tenantId, 'shop.example.test', 24 * 9, { sent: 1000 }); // outside the 7 days
    await sent(tenantId, 'relay-only.example.test', 3, { sent: 2 });
    await sent(otherTenantId, 'other.example.test', 1, { sent: 50 });
    await sent(otherTenantId, 'shop.example.test', 1, { sent: 40 }); // another tenant, same name
  });

  it('lists every email domain of the tenant with its 24-hour and 7-day figures, busiest first', async () => {
    const stats = await getTenantMailDomainStats(db(), tenantId);
    expect(stats.windowDays).toBe(7);
    expect(stats.domains).toEqual([
      { domain: 'shop.example.test', emailHosted: true, sent24h: 5, sent7d: 12, recipients7d: 16, rateLimited7d: 1, quotaRejected7d: 2 },
      { domain: 'relay-only.example.test', emailHosted: false, sent24h: 2, sent7d: 2, recipients7d: 2, rateLimited7d: 0, quotaRejected7d: 0 },
      { domain: 'quiet.example.test', emailHosted: true, sent24h: 0, sent7d: 0, recipients7d: 0, rateLimited7d: 0, quotaRejected7d: 0 },
    ]);
  });

  it('serves the tenant its own figures and refuses another tenant’s', async () => {
    const own = generateToken(app, { role: 'tenant_user', panel: 'tenant', tenantId });
    const res = await app.inject({ method: 'GET', url: `/api/v1/tenants/${tenantId}/mail/domain-stats`, headers: { authorization: `Bearer ${own}` } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { domains: Array<{ domain: string }> } }).data.domains.map((d) => d.domain))
      .toEqual(['shop.example.test', 'relay-only.example.test', 'quiet.example.test']);

    const other = await app.inject({ method: 'GET', url: `/api/v1/tenants/${otherTenantId}/mail/domain-stats`, headers: { authorization: `Bearer ${own}` } });
    expect(other.statusCode).toBe(403);
  });
});
