/**
 * A route can be switched off and back on without losing anything: through
 * the real handler, on real Postgres, every other column comes back as it was.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import { closeTestDb, cleanTables, getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { seedDomain, seedPlan, seedRegion, seedTenant } from '../../test-helpers/fixtures.js';
import { ingressRoutes } from '../../db/schema.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('switching a route off and on (integration)', () => {
  let app: FastifyInstance;
  const db = () => getTestDb();
  let token = '';
  let base = '';
  let routeId = '';
  let tenantId = '';

  beforeAll(async () => {
    await runMigrations();
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', getTestDb());
    const { ingressRouteRoutes } = await import('./routes.js');
    await app.register(ingressRouteRoutes, { prefix: '/api/v1' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await cleanTables();
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    const tenant = await seedTenant(db(), region.id, plan.id);
    tenantId = tenant.id;
    const domain = await seedDomain(db(), tenant.id, { domainName: 'shop.example.test' });
    routeId = randomUUID();
    // Inserted the way every existing row was: without naming the column.
    await db().execute(sql`
      INSERT INTO ingress_routes (id, domain_id, hostname, ingress_cname, status, force_https, www_redirect,
                                  redirect_url, waf_enabled, waf_detection_only, ip_allowlist, hsts_enabled)
      VALUES (${routeId}, ${domain.id}, 'shop.example.test', 'unused.example.test', 'active', 1, 'add-www',
              'https://elsewhere.example.test/', 1, 1, '192.0.2.0/24', 1)
    `);
    token = app.jwt.sign({
      sub: `user-${tenant.id}`, role: 'tenant_admin', panel: 'tenant', tenantId: tenant.id, iat: Math.floor(Date.now() / 1000),
    });
    base = `/api/v1/tenants/${tenant.id}/domains/${domain.id}/routes`;
  });

  const call = (method: 'GET' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const row = async () => (await db().select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId)))[0];
  /** Everything but the switch and the timestamp it bumps. */
  const settings = (r: typeof ingressRoutes.$inferSelect) => {
    const { enabled: _enabled, updatedAt: _updatedAt, ...rest } = r;
    return rest;
  };

  it('an existing route is on: the migration default keeps every site serving', async () => {
    expect((await row())?.enabled).toBe(true);
    expect((await call('GET', base)).json().data[0]).toMatchObject({ id: routeId, enabled: true });
  });

  it('switches off and back on, and no other setting moves', async () => {
    const before = await row();

    const off = await call('PATCH', `${base}/${routeId}`, { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().data).toMatchObject({ id: routeId, enabled: false, wafMode: 'detection', forceHttps: true });
    expect((await row())?.enabled).toBe(false);
    expect(settings((await row())!)).toEqual(settings(before!));
    // Both reads the panel uses agree.
    expect((await call('GET', base)).json().data[0].enabled).toBe(false);
    expect((await call('GET', `/api/v1/tenants/${tenantId}/routes/${routeId}`)).json().data.enabled).toBe(false);

    const on = await call('PATCH', `${base}/${routeId}`, { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().data.enabled).toBe(true);
    expect(settings((await row())!)).toEqual(settings(before!));
  });

  it('a PATCH that does not name the switch leaves it alone', async () => {
    await call('PATCH', `${base}/${routeId}`, { enabled: false });
    expect((await call('PATCH', `${base}/${routeId}`, { tls_mode: 'auto' })).statusCode).toBe(200);
    expect((await row())?.enabled).toBe(false);
  });

  it('refuses a switch value that is not a boolean', async () => {
    const res = await call('PATCH', `${base}/${routeId}`, { enabled: 'no' });
    expect(res.statusCode).toBe(400);
    expect((await row())?.enabled).toBe(true);
  });
});
