/**
 * Every server-sortable admin list, on real Postgres: each allowed field in
 * both directions runs (its SQL expression, its cast, its cursor), pages of
 * one row continue the same order without a repeat, and a field the endpoint
 * does not allow answers 400 INVALID_SORT_FIELD.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { randomUUID } from 'node:crypto';
import { errorHandler } from '../middleware/error-handler.js';
import { registerAuth } from '../middleware/auth.js';
import { closeTestDb, cleanTables, getTestDb, isDbAvailable, runMigrations } from '../test-helpers/db.js';
import { seedDomain, seedPlan, seedRegion, seedTenant } from '../test-helpers/fixtures.js';
import { auditLogs, cronJobs, sftpUsers, users } from '../db/schema.js';
import { TENANT_SORT_FIELDS, listTenants } from '../modules/tenants/service.js';
import { ADMIN_DOMAIN_SORT_FIELDS, listAllDomains, listDomains } from '../modules/domains/service.js';
import { ADMIN_CRON_JOB_SORT_FIELDS, listAllCronJobs, listCronJobs } from '../modules/cron-jobs/service.js';
import { ADMIN_SFTP_USER_SORT_FIELDS, listAllSftpUsers } from '../modules/sftp-users/service.js';

const dbAvailable = await isDbAvailable();

type Page = { data: Array<{ id: string }>; pagination: { cursor: string | null } };

/** Walk the whole list one row per page; return the ids in order. */
async function walk(first: (cursor?: string) => Promise<Page>): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await first(cursor);
    ids.push(...page.data.map((r) => r.id));
    if (!page.pagination.cursor) return ids;
    cursor = page.pagination.cursor;
  }
  throw new Error('list did not end');
}

describe.skipIf(!dbAvailable)('server-sorted admin lists (integration)', () => {
  const db = () => getTestDb();
  let app: FastifyInstance;
  let token = '';

  beforeAll(async () => {
    await runMigrations();
    await cleanTables();
    const region = await seedRegion(db());
    const planA = await seedPlan(db(), { name: 'Alpha plan' });
    const planB = await seedPlan(db(), { name: 'beta plan' });
    const names = ['delta', 'Alpha', 'charlie', 'bravo', 'alpha'];
    for (const [i, name] of names.entries()) {
      const t = await seedTenant(db(), region.id, i % 2 ? planA.id : planB.id, {
        name, subscriptionExpiresAt: i === 0 ? null : new Date(Date.UTC(2027, 0, 1 + (i % 2))),
      });
      await seedDomain(db(), t.id, { domainName: `${name.toLowerCase()}-${i}.example.test` });
      await db().insert(cronJobs).values({
        id: randomUUID(), tenantId: t.id, name: `job-${name}`, schedule: '*/5 * * * *', type: 'webcron',
        url: 'https://example.test/', enabled: i % 2,
      } as typeof cronJobs.$inferInsert);
      await db().insert(sftpUsers).values({
        id: randomUUID(), tenantId: t.id, username: `sftp${i}`, homePath: `/site${i % 2}`, passwordHash: 'x',
      } as typeof sftpUsers.$inferInsert);
      await db().insert(users).values({
        id: randomUUID(), email: `u${i}@example.test`, passwordHash: 'x', fullName: `User ${i}`, panel: 'tenant', tenantId: t.id,
        roleName: i % 2 ? 'tenant_admin' : 'tenant_user', status: 'active',
      } as typeof users.$inferInsert);
      await db().insert(auditLogs).values({
        id: randomUUID(), actionType: i % 2 ? 'update' : 'create', resourceType: 'tenant', actorId: 'a',
        httpMethod: 'PATCH', httpPath: `/x/${i}`,
      } as typeof auditLogs.$inferInsert);
    }

    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', getTestDb());
    const { adminUserRoutes } = await import('../modules/admin-users/routes.js');
    const { mailboxRoutes } = await import('../modules/mailboxes/routes.js');
    const { auditLogRoutes } = await import('../modules/audit-logs/routes.js');
    const { notificationAdminRoutes } = await import('../modules/notifications/routes-admin.js');
    await app.register(adminUserRoutes, { prefix: '/api/v1' });
    await app.register(mailboxRoutes, { prefix: '/api/v1' });
    await app.register(auditLogRoutes, { prefix: '/api/v1' });
    await app.register(notificationAdminRoutes, { prefix: '/api/v1' });
    await app.ready();
    token = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });
  afterAll(async () => {
    await app?.close();
    await closeTestDb();
  });

  const SERVICES = [
    ['tenants', TENANT_SORT_FIELDS, (sortParam: string, cursor?: string) => listTenants(db(), { limit: 1, cursor, sortParam })],
    ['domains', ADMIN_DOMAIN_SORT_FIELDS, (sortParam: string, cursor?: string) => listAllDomains(db(), { limit: 1, cursor, sortParam })],
    ['cron jobs', ADMIN_CRON_JOB_SORT_FIELDS, (sortParam: string, cursor?: string) => listAllCronJobs(db(), { limit: 1, cursor, sortParam })],
    ['sftp users', ADMIN_SFTP_USER_SORT_FIELDS, (sortParam: string, cursor?: string) => listAllSftpUsers(db(), { limit: 1, cursor, sortParam })],
  ] as const;

  for (const [name, fields, list] of SERVICES) {
    it(`${name}: every field, both directions, pages without a repeat`, async () => {
      for (const field of Object.keys(fields)) {
        for (const dir of ['asc', 'desc']) {
          const ids = await walk((cursor) => list(`${field}:${dir}`, cursor) as Promise<Page>);
          expect(ids, `${field}:${dir}`).toHaveLength(5);
          expect(new Set(ids).size, `${field}:${dir}`).toBe(5);
        }
      }
    });
  }

  it('the per-tenant domain and cron lists take the same sort fields (no tenants join there)', async () => {
    const [t] = (await listTenants(db(), { limit: 1, sortParam: 'name:asc' })).data;
    for (const field of Object.keys(ADMIN_DOMAIN_SORT_FIELDS)) {
      for (const dir of ['asc', 'desc']) {
        expect((await listDomains(db(), t.id, { limit: 10, sortParam: `${field}:${dir}` })).data, `domains ${field}:${dir}`).toHaveLength(1);
      }
    }
    for (const field of Object.keys(ADMIN_CRON_JOB_SORT_FIELDS)) {
      for (const dir of ['asc', 'desc']) {
        expect((await listCronJobs(db(), t.id, { limit: 10, sortParam: `${field}:${dir}` })).data, `cron ${field}:${dir}`).toHaveLength(1);
      }
    }
  });

  it('tenants sort by name across pages, case-insensitively — not just within one page', async () => {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listTenants(db(), { limit: 2, cursor, sortParam: 'name:asc' });
      names.push(...page.data.map((t) => t.name));
      cursor = page.pagination.cursor ?? undefined;
    } while (cursor);
    expect(names.map((n) => n.toLowerCase())).toEqual(['alpha', 'alpha', 'bravo', 'charlie', 'delta']);
  });

  it('the tenants total stays the whole list on every page', async () => {
    const totals: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await listTenants(db(), { limit: 2, cursor, sortParam: 'name:asc' });
      totals.push(page.pagination.total_count);
      cursor = page.pagination.cursor ?? undefined;
    } while (cursor);
    expect(totals).toEqual([5, 5, 5]);
  });

  const ROUTES: Array<[string, string[]]> = [
    ['/admin/tenant-users', ['email', 'tenantName', 'roleName', 'status', 'lastLoginAt', 'createdAt']],
    ['/admin/mailboxes', ['fullAddress', 'tenantName', 'mailboxType', 'status', 'quotaMb', 'usedMb', 'createdAt']],
    ['/admin/audit-logs', ['createdAt', 'actionType', 'resourceType', 'httpMethod', 'httpPath', 'actorId', 'ipAddress']],
    ['/admin/notifications/deliveries', ['queuedAt', 'channel', 'categoryId', 'status', 'recipientHash', 'attempt', 'lastError']],
  ];
  for (const [path, fields] of ROUTES) {
    it(`${path}: every field sorts on the server, and an unknown one is refused`, async () => {
      for (const field of fields) {
        for (const dir of ['asc', 'desc']) {
          const ids = await walk(async (cursor) => {
            const qs = new URLSearchParams({ limit: '1', sort: `${field}:${dir}`, ...(cursor ? { cursor } : {}) });
            const res = await app.inject({ method: 'GET', url: `/api/v1${path}?${qs}`, headers: { authorization: `Bearer ${token}` } });
            expect(res.statusCode, `${field}:${dir} ${res.body}`).toBe(200);
            return res.json() as Page;
          });
          expect(new Set(ids).size, `${field}:${dir}`).toBe(ids.length);
        }
      }
      const bad = await app.inject({ method: 'GET', url: `/api/v1${path}?sort=passwordHash:asc`, headers: { authorization: `Bearer ${token}` } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('INVALID_SORT_FIELD');
    });
  }
});
