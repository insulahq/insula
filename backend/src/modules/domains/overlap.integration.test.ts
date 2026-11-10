/**
 * A tenant cannot add a domain that overlaps another account's — through the
 * real handlers, on real Postgres.
 *
 * Primary-mode zones share the platform's nameservers, which answer from the
 * most specific zone they hold, so a tenant's `shop.example.test` zone took
 * that name over from another tenant's `example.test` as soon as it was
 * created. A name that differed only in case was accepted as a new domain.
 * Mail could be turned on for a domain nobody had verified, and a tenant could
 * PATCH its domain's status to `verified`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { closeTestDb, cleanTables, getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { buildTestApp, generateToken } from '../../test-helpers/app.js';
import { seedDomain, seedPlan, seedRegion, seedTenant } from '../../test-helpers/fixtures.js';
import { domains, platformSettings } from '../../db/schema.js';
import { _resetReservedHostnamesCache } from '../system-tenant/reserved-subdomains.js';
import { createRoute } from '../ingress-routes/service.js';

const dbAvailable = await isDbAvailable();
const APEX = 'platform.example.test';

describe.skipIf(!dbAvailable)('domain overlap across accounts (integration)', () => {
  let app: FastifyInstance;
  const db = () => getTestDb();
  let adminToken = '';
  let tenantA = '';
  let tenantB = '';
  let tokenB = '';

  const addDomain = (token: string, tenantId: string, domainName: string, dnsMode = 'cname') =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/domains`,
      headers: { authorization: `Bearer ${token}` },
      payload: { domain_name: domainName, dns_mode: dnsMode },
    });

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    adminToken = generateToken(app, { role: 'admin' });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await cleanTables();
    await db().delete(platformSettings).where(eq(platformSettings.key, 'platform_domain'));
    await db().insert(platformSettings).values({ key: 'platform_domain', value: APEX });
    _resetReservedHostnamesCache();
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    tenantA = (await seedTenant(db(), region.id, plan.id)).id;
    tenantB = (await seedTenant(db(), region.id, plan.id)).id;
    tokenB = generateToken(app, { sub: `user-${tenantB}`, role: 'tenant_admin', panel: 'tenant', tenantId: tenantB });
    await seedDomain(db(), tenantA, { domainName: 'example.test' });
  });

  describe('names are case-insensitive', () => {
    it('stores a new name lowercased', async () => {
      const res = await addDomain(tokenB, tenantB, '  Fresh.EXAMPLE.net ');
      expect(res.statusCode).toBe(201);
      expect(res.json().data.domainName).toBe('fresh.example.net');
    });

    it("refuses another tenant's domain spelled with capitals", async () => {
      const res = await addDomain(tokenB, tenantB, 'EXAMPLE.test');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DUPLICATE_ENTRY');
    });

    it('refuses it for staff too: a case-only duplicate is never intended', async () => {
      const res = await addDomain(adminToken, tenantB, 'Example.Test');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DUPLICATE_ENTRY');
    });

    it('matches a stored name that still has capitals', async () => {
      await seedDomain(db(), tenantA, { domainName: 'Legacy.Example.net' });
      const res = await addDomain(adminToken, tenantB, 'legacy.example.net');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DUPLICATE_ENTRY');
    });
  });

  describe('a tenant adding its own domain', () => {
    it("is refused a subdomain of another tenant's domain, whether or not the platform runs its DNS", async () => {
      for (const mode of ['cname', 'primary']) {
        const res = await addDomain(tokenB, tenantB, `shop-${mode}.example.test`, mode);
        expect(res.statusCode, mode).toBe(409);
        expect(res.json().error.code).toBe('DOMAIN_OVERLAPS_ANOTHER_ACCOUNT');
      }
    });

    it('is not told which domain or account it overlaps, nor how', async () => {
      await seedDomain(db(), tenantA, { domainName: 'www.parent.example.net' });
      const inside = await addDomain(tokenB, tenantB, 'shop.example.test');
      const contains = await addDomain(tokenB, tenantB, 'parent.example.net');
      const platform = await addDomain(tokenB, tenantB, `login.${APEX}`);
      const body = JSON.stringify(inside.json());
      expect(body).toContain('shop.example.test');
      expect(body).not.toMatch(/'example\.test'/);
      expect(body).not.toContain(tenantA);
      // A parent, a subdomain and the platform's own domain read the same,
      // name aside, so the wording is no oracle for what is hosted here.
      const message = (r: typeof inside) => (r.json().error.message as string).replace(/^'[^']+'/, "'X'");
      expect(message(contains)).toBe(message(inside));
      expect(message(platform)).toBe(message(inside));
    });

    it("is refused a parent of another tenant's domain", async () => {
      await seedDomain(db(), tenantA, { domainName: 'www.parent.example.net' });
      const res = await addDomain(tokenB, tenantB, 'parent.example.net');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DOMAIN_OVERLAPS_ANOTHER_ACCOUNT');
    });

    it("is refused a name under the platform's apex, with or without a domain row for it", async () => {
      const res = await addDomain(tokenB, tenantB, `login.${APEX}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DOMAIN_OVERLAPS_ANOTHER_ACCOUNT');
    });

    it('may add a subdomain of a domain it owns itself', async () => {
      const tokenA = generateToken(app, { sub: `user-${tenantA}`, role: 'tenant_admin', panel: 'tenant', tenantId: tenantA });
      const res = await addDomain(tokenA, tenantA, 'shop.example.test');
      expect(res.statusCode).toBe(201);
    });

    it('is held to the rule when an operator acts as the tenant (tenant-panel token)', async () => {
      const impersonating = generateToken(app, { sub: 'operator', role: 'admin', panel: 'tenant', tenantId: tenantB });
      const res = await addDomain(impersonating, tenantB, 'shop.example.test');
      expect(res.statusCode).toBe(409);
    });
  });

  it("lets staff add a subdomain of another tenant's domain on purpose", async () => {
    const res = await addDomain(adminToken, tenantB, 'shop.example.test');
    expect(res.statusCode).toBe(201);
  });

  describe("a domain's status", () => {
    it('cannot be set by the tenant', async () => {
      const own = await seedDomain(db(), tenantB, { domainName: 'mine.example.net', status: 'unverified' });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenants/${tenantB}/domains/${own.id}`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { status: 'verified' },
      });
      expect(res.statusCode).toBe(403);
      const [row] = await db().select({ status: domains.status }).from(domains).where(eq(domains.id, own.id));
      expect(row.status).toBe('unverified');
    });

    it('can still be overridden by staff', async () => {
      const own = await seedDomain(db(), tenantB, { domainName: 'mine.example.net', status: 'unverified' });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenants/${tenantB}/domains/${own.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: 'suspended' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  it('refuses a second route for a host and path another domain already routes', async () => {
    // Staff may create the overlapping domain, but not a second Ingress rule
    // for a request the first domain's route already answers.
    const [parent] = await db().select({ id: domains.id }).from(domains).where(eq(domains.domainName, 'example.test'));
    await createRoute(db(), parent.id, tenantA, 'shop.example.test');
    const child = await seedDomain(db(), tenantB, { domainName: 'shop.example.test' });
    await expect(createRoute(db(), child.id, tenantB, 'SHOP.example.test')).rejects.toMatchObject({ code: 'DUPLICATE_ROUTE' });
    // Another path on the same host is a different request.
    await expect(createRoute(db(), child.id, tenantB, 'shop.example.test', null, '/blog')).resolves.toBeTruthy();
  });

  describe('turning mail on', () => {
    const enable = (token: string, tenantId: string, domainId: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenantId}/email/domains/${domainId}/enable`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

    it('is refused to a tenant for a domain that never passed verification', async () => {
      // `.test` has no MX anywhere, so the MX proof cannot pass either.
      const own = await seedDomain(db(), tenantB, { domainName: 'unproven.example.test', status: 'unverified', verifiedAt: null });
      const res = await enable(tokenB, tenantB, own.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DOMAIN_DNS_CONTROL_UNPROVEN');
    });

    it('is allowed to a tenant once the domain has been verified', async () => {
      const own = await seedDomain(db(), tenantB, { domainName: 'proven.example.net', status: 'verified', verifiedAt: new Date() });
      const res = await enable(tokenB, tenantB, own.id);
      expect(res.statusCode).toBe(201);
    });

    it('is allowed to staff without the proof', async () => {
      const own = await seedDomain(db(), tenantB, { domainName: 'operator.example.test', status: 'unverified', verifiedAt: null });
      const res = await enable(adminToken, tenantB, own.id);
      expect(res.statusCode).toBe(201);
    });
  });
});
