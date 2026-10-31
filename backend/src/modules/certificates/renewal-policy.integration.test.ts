/**
 * The renewal policy on real Postgres: the tenant Domains list (the orange
 * "expiring" badge) and the dashboards' SQL form of the policy must agree with
 * renewal-policy.ts on the same certificates.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { closeTestDb, cleanTables, getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { seedDomain, seedPlan, seedRegion, seedTenant } from '../../test-helpers/fixtures.js';
import { sslCertificates } from '../../db/schema.js';
import { listDomains } from '../domains/service.js';
import { buildTenantSummary } from '../dashboard/tenant-service.js';
import { buildAdminSummary } from '../dashboard/admin-service.js';
import { certificateExpiryState } from './renewal-policy.js';
import { autoRenewedSql, renewalAtSql, renewalOverdueSql } from './renewal-policy-sql.js';

const dbAvailable = await isDbAvailable();
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!dbAvailable)('certificate renewal policy (integration)', () => {
  const db = () => getTestDb();
  let tenantId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    tenantId = (await seedTenant(db(), region.id, plan.id)).id;
  });

  /** A domain with one certificate of `lifetimeDays`, `leftDays` from expiry. */
  const seedCert = async (name: string, lifetimeDays: number | null, leftDays: number, autoRenew = true, uploaded = false) => {
    // An upload leaves the domain's auto-renew flag as it was.
    const domain = await seedDomain(db(), tenantId, { domainName: `${name}.example.test`, sslAutoRenew: autoRenew || uploaded ? 1 : 0 });
    const notAfter = new Date(Date.now() + leftDays * DAY);
    const notBefore = lifetimeDays === null ? null : new Date(notAfter.getTime() - lifetimeDays * DAY);
    await db().insert(sslCertificates).values({
      id: randomUUID(), domainId: domain.id, tenantId,
      certificate: uploaded ? '-----BEGIN CERTIFICATE-----' : '# Managed by cert-manager',
      privateKeyEncrypted: uploaded ? 'encrypted-key' : '# Managed by cert-manager',
      status: 'issued', notBefore, expiresAt: notAfter,
    });
    return { domainId: domain.id, notBefore, notAfter, autoRenew: autoRenew && !uploaded };
  };

  const CASES: Array<[string, number | null, number, boolean, boolean?]> = [
    // name, lifetime, days left, auto-renewed
    ['renewing-21d', 89, 21, true], // inside the renewal window: the old 30-day mark showed it orange
    ['renewing-30d', 89, 30, true],
    ['fresh', 89, 80, true],
    ['overdue-90', 90, 10, true],
    ['short-45-ok', 45, 9, true],
    ['short-45-overdue', 45, 6, true],
    ['year-overdue', 365, 21, true],
    ['unknown-start', null, 16, true],
    ['expired', 90, -1, true],
    ['manual-ok', 365, 40, false],
    ['manual-soon', 365, 25, false],
    // Uploaded on a domain still flagged auto-renew: nobody renews it.
    ['uploaded-soon', 90, 25, false, true],
  ];

  it('the Domains list shows "expiring" only for overdue renewals, never inside the renewal window', async () => {
    for (const [name, life, left, autoRenew, uploaded] of CASES) await seedCert(name, life, left, autoRenew, uploaded);
    const { data } = await listDomains(db(), tenantId, { limit: 100, sort: { field: 'domainName', direction: 'asc' } });
    const status = Object.fromEntries(
      (data as Array<{ domainName: string; tlsCertStatus?: string }>).map((d) => [d.domainName.split('.')[0], d.tlsCertStatus]),
    );
    expect(status).toEqual({
      'renewing-21d': 'active',
      'renewing-30d': 'active',
      fresh: 'active',
      'overdue-90': 'expiring',
      'short-45-ok': 'active',
      'short-45-overdue': 'expiring',
      'year-overdue': 'expiring',
      'unknown-start': 'active',
      expired: 'expired',
      'manual-ok': 'active',
      'manual-soon': 'expiring',
      'uploaded-soon': 'expiring',
    });
  });

  it('the SQL form of the policy agrees with the TypeScript one on every case', async () => {
    const seeded = [];
    for (const [name, life, left, autoRenew, uploaded] of CASES) seeded.push({ name, ...(await seedCert(name, life, left, autoRenew, uploaded)) });
    const r = await db().execute<{ domain_id: string; overdue: boolean; renew_at: string }>(sql`
      SELECT s.domain_id,
             ${renewalOverdueSql('s', autoRenewedSql('s', 'd'))} AS overdue,
             ${renewalAtSql('s', autoRenewedSql('s', 'd'))} AS renew_at
        FROM ssl_certificates s JOIN domains d ON d.id = s.domain_id
    `);
    const byDomain = new Map(r.rows.map((row) => [row.domain_id, row]));
    const now = new Date();
    for (const c of seeded) {
      const ts = certificateExpiryState({ notBefore: c.notBefore, notAfter: c.notAfter }, { autoRenewed: c.autoRenew, now });
      expect(byDomain.get(c.domainId)?.overdue, c.name).toBe(ts === 'expiring' || ts === 'expired');
    }
    // An 89-day certificate with 21 days left renews now (renewal point ~29.4 days left).
    const renewing = seeded.find((c) => c.name === 'renewing-21d')!;
    expect(new Date(byDomain.get(renewing.domainId)!.renew_at).getTime()).toBeLessThan(now.getTime());
    const fresh = seeded.find((c) => c.name === 'fresh')!;
    const renewAt = new Date(byDomain.get(fresh.domainId)!.renew_at).getTime();
    expect(Math.round((renewAt - now.getTime()) / DAY)).toBe(Math.round(80 - 89 * 0.33));
  });

  it('the dashboards say when certificates renew and how many renewals are overdue', async () => {
    await seedCert('fresh', 89, 80);
    await seedCert('renewing-21d', 89, 21);
    const tenant = await buildTenantSummary(db(), tenantId);
    // renewing-21d is renewing now: "Renews in" 0, not the 21 days until expiry.
    expect(tenant.domains.data?.nearestRenewalDays).toBe(0);
    let admin = await buildAdminSummary(db());
    expect(admin.certificates.data).toMatchObject({ issued: 2, overdue: 0 });

    await seedCert('overdue-90', 90, 10);
    admin = await buildAdminSummary(db());
    expect(admin.certificates.data).toMatchObject({ issued: 3, overdue: 1 });
  });

  it('"Renews in" counts to the renewal point, a third of the lifetime before expiry', async () => {
    await seedCert('fresh', 89, 80);
    const tenant = await buildTenantSummary(db(), tenantId);
    // 80 days left on an 89-day certificate: renews in 80 - 89 × 0.33 ≈ 50.6 days.
    expect(tenant.domains.data?.nearestRenewalDays).toBe(50);
  });
});
