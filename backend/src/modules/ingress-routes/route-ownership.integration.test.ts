/**
 * A tenant can reach only its own routes' protected directories, their users
 * and the routes' WAF logs — through the real handlers, on real Postgres.
 *
 * `requireTenantAccess` checks `:tenantId` against the caller's token; these
 * handlers used to query by `:routeId` / `:dirId` alone, so tenant B, naming
 * itself in the URL and tenant A's ids after it, could list A's directory
 * users, add a login to A's protected folder, disable or delete A's users,
 * reset their passwords, and read A's WAF log.
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
import { ingressRoutes, routeAuthUsers, wafLogs } from '../../db/schema.js';
import { createDirUser, createProtectedDir } from './protected-dirs-service.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('tenant route ownership — protected directories and WAF logs (integration)', () => {
  let app: FastifyInstance;
  const db = () => getTestDb();
  const ids = { a: '', b: '', routeA: '', routeB: '', dirA: '', userA: '' };
  let tokenA = '';
  let tokenB = '';

  const seedSite = async (regionId: string, planId: string, host: string) => {
    const tenant = await seedTenant(db(), regionId, planId);
    const domain = await seedDomain(db(), tenant.id, { domainName: host });
    const routeId = randomUUID();
    await db().insert(ingressRoutes).values({ id: routeId, domainId: domain.id, hostname: host, ingressCname: 'unused.example.test' });
    return { tenantId: tenant.id, routeId };
  };

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
    // waf_logs rows outlive their tenant (route_id is SET NULL); directories go with the routes.
    await db().execute(sql.raw('DELETE FROM waf_logs'));
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    const a = await seedSite(region.id, plan.id, 'a.example.test');
    const b = await seedSite(region.id, plan.id, 'b.example.test');
    Object.assign(ids, { a: a.tenantId, b: b.tenantId, routeA: a.routeId, routeB: b.routeId });
    const dir = await createProtectedDir(db(), a.routeId, a.tenantId, { path: '/private', realm: 'A only' });
    ids.dirA = dir.id;
    const user = await createDirUser(db(), dir.id, a.routeId, a.tenantId, 'alice', 'correct-horse-battery');
    ids.userA = user.id;
    await db().insert(wafLogs).values({
      id: randomUUID(), routeId: a.routeId, tenantId: a.tenantId, hostname: 'a.example.test', ruleId: '942100',
      severity: 'critical', message: 'SQL Injection', requestUri: '/?id=1', requestMethod: 'GET', sourceIp: '192.0.2.10',
    });
    const sign = (tenantId: string) => app.jwt.sign({
      sub: `user-${tenantId}`, role: 'tenant_admin', panel: 'tenant', tenantId, iat: Math.floor(Date.now() / 1000),
    });
    tokenA = sign(a.tenantId);
    tokenB = sign(b.tenantId);
  });

  const call = (token: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const userRow = async () => (await db().select().from(routeAuthUsers).where(eq(routeAuthUsers.id, ids.userA)))[0];

  it('tenant B is refused every read and write on tenant A\'s route, directory and users', async () => {
    const before = await userRow();
    const B = `/tenants/${ids.b}`;
    const attempts: Array<[string, 'GET' | 'POST' | 'DELETE', string, object?]> = [
      ['WAF log', 'GET', `${B}/routes/${ids.routeA}/waf-logs`],
      ['directory list', 'GET', `${B}/routes/${ids.routeA}/protected-dirs`],
      ['user list', 'GET', `${B}/routes/${ids.routeA}/protected-dirs/${ids.dirA}/users`],
      ['user list via B\'s own route', 'GET', `${B}/routes/${ids.routeB}/protected-dirs/${ids.dirA}/users`],
      ['add a login', 'POST', `${B}/routes/${ids.routeB}/protected-dirs/${ids.dirA}/users`, { username: 'mallory', password: 'mallory-password-1' }],
      ['disable a user', 'POST', `${B}/routes/${ids.routeB}/protected-dirs/${ids.dirA}/users/${ids.userA}/toggle`, { enabled: false }],
      ['reset a password', 'POST', `${B}/routes/${ids.routeB}/protected-dirs/${ids.dirA}/users/${ids.userA}/change-password`, { password: 'mallory-password-2' }],
      ['delete a user', 'DELETE', `${B}/routes/${ids.routeB}/protected-dirs/${ids.dirA}/users/${ids.userA}`],
    ];
    for (const [label, method, url, payload] of attempts) {
      const res = await call(tokenB, method, url, payload);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(404);
      expect(res.body, label).not.toContain('alice');
      expect(res.body, label).not.toContain('192.0.2.10');
    }
    // Nothing of A's changed.
    const after = await userRow();
    expect(after).toEqual(before);
    const logins = await db().select().from(routeAuthUsers);
    expect(logins.map((u) => u.username)).toEqual(['alice']);
  });

  it('tenant A still reads and manages its own', async () => {
    const A = `/tenants/${ids.a}/routes/${ids.routeA}`;
    expect((await call(tokenA, 'GET', `${A}/waf-logs`)).json().data).toHaveLength(1);
    expect((await call(tokenA, 'GET', `${A}/protected-dirs`)).json().data[0]).toMatchObject({ id: ids.dirA, userCount: 1 });
    expect((await call(tokenA, 'GET', `${A}/protected-dirs/${ids.dirA}/users`)).json().data[0]).toMatchObject({ username: 'alice' });
    expect((await call(tokenA, 'POST', `${A}/protected-dirs/${ids.dirA}/users`, { username: 'bob', password: 'bob-password-123' })).statusCode).toBe(201);
    expect((await call(tokenA, 'POST', `${A}/protected-dirs/${ids.dirA}/users/${ids.userA}/toggle`, { enabled: false })).statusCode).toBe(200);
    expect((await userRow())?.enabled).toBeFalsy();
    expect((await call(tokenA, 'POST', `${A}/protected-dirs/${ids.dirA}/users/${ids.userA}/change-password`, { password: 'alice-new-password' })).statusCode).toBe(200);
    expect((await call(tokenA, 'DELETE', `${A}/protected-dirs/${ids.dirA}/users/${ids.userA}`)).statusCode).toBe(204);
  });
});
