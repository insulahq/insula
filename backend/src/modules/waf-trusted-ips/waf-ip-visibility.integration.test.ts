/**
 * Who sent a WAF event and whether it was blocked, on real Postgres and the
 * real handlers: a route's trusted IPs (tenant CRUD, ownership, canonical
 * values, limits, what the reconciler renders), the scraper's pass reasons
 * and wildcard-route attribution, the paged event list, the by-source view,
 * the summary's top addresses, and the one-off backfill.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

// The routes re-render the WAF inline after a change; no cluster here.
const reconcile = vi.hoisted(() => vi.fn(async () => ({ ran: true })));
vi.mock('../waf-rule-exclusions/scheduler.js', () => ({ runWafExclusionReconcile: reconcile }));
vi.mock('../k8s-provisioner/k8s-client.js', () => ({ createK8sClients: vi.fn(() => ({ core: {}, apps: {} })) }));

import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import { closeTestDb, cleanTables, getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { seedDomain, seedPlan, seedRegion, seedTenant } from '../../test-helpers/fixtures.js';
import { ingressRoutes, wafLogs } from '../../db/schema.js';
import { listTrustedIpsForReconciler } from './service.js';
import { scrapeWafLogs } from '../ingress-routes/waf-log-scraper.js';
import { backfillAllowlistedPassReasons } from '../waf-logs/pass-reason.js';
import { addressMatcher } from './ip-value.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('WAF trusted IPs and source attribution (integration)', () => {
  let app: FastifyInstance;
  const db = () => getTestDb();
  const ids = { a: '', b: '', routeA: '', routeB: '', routeWild: '' };
  let tokenA = '';
  let tokenB = '';

  const call = (token: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

  const row = (over: Partial<typeof wafLogs.$inferInsert>) => ({
    id: randomUUID(), routeId: ids.routeA, tenantId: ids.a, hostname: 'a.example.test', ruleId: '941100',
    severity: 'critical', message: 'XSS Attack Detected via libinjection', requestUri: '/mcp', requestMethod: 'POST',
    sourceIp: '203.0.113.7', ...over,
  });

  beforeAll(async () => {
    await runMigrations();
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', getTestDb());
    const { wafTrustedIpRoutes } = await import('./routes.js');
    const { ingressRouteRoutes } = await import('../ingress-routes/routes.js');
    const { wafLogRoutes } = await import('../waf-logs/routes.js');
    await app.register(wafTrustedIpRoutes, { prefix: '/api/v1' });
    await app.register(ingressRouteRoutes, { prefix: '/api/v1' });
    await app.register(wafLogRoutes, { prefix: '/api/v1' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    reconcile.mockClear();
    await cleanTables();
    await db().execute(sql`DELETE FROM waf_logs`);
    await db().execute(sql`DELETE FROM platform_settings WHERE setting_key = 'waf-logs-pass-reason-backfill'`);
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    const a = await seedTenant(db(), region.id, plan.id);
    const b = await seedTenant(db(), region.id, plan.id);
    const domA = await seedDomain(db(), a.id, { domainName: 'a.example.test' });
    const domB = await seedDomain(db(), b.id, { domainName: 'b.example.test' });
    ids.a = a.id; ids.b = b.id;
    ids.routeA = randomUUID(); ids.routeB = randomUUID(); ids.routeWild = randomUUID();
    await db().insert(ingressRoutes).values([
      { id: ids.routeA, domainId: domA.id, hostname: 'a.example.test', ingressCname: 'unused.example.test' },
      { id: ids.routeWild, domainId: domA.id, hostname: '*.sites.a.example.test', ingressCname: 'unused.example.test' },
      { id: ids.routeB, domainId: domB.id, hostname: 'b.example.test', ingressCname: 'unused.example.test' },
    ]);
    const sign = (tenantId: string) => app.jwt.sign({
      sub: `user-${tenantId}`, email: `owner-${tenantId.slice(0, 4)}@example.test`, role: 'tenant_admin', panel: 'tenant', tenantId, iat: Math.floor(Date.now() / 1000),
    });
    tokenA = sign(a.id);
    tokenB = sign(b.id);
  });

  describe('trusted IPs of a route', () => {
    it('stores the canonical value, lists it, re-renders the WAF, and removes it', async () => {
      const created = await call(tokenA, 'POST', `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips`, { value: '203.0.113.9/24', note: 'office\nnetwork' });
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json().data).toMatchObject({ value: '203.0.113.0/24', note: 'office network', routeId: ids.routeA });
      expect(reconcile).toHaveBeenCalledTimes(1);
      const v6 = await call(tokenA, 'POST', `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips`, { value: '2001:DB8:0:0::1' });
      expect(v6.json().data.value).toBe('2001:db8::1');

      const list = await call(tokenA, 'GET', `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips`);
      expect(list.json().data).toMatchObject({ max: 20 });
      expect(list.json().data.trustedIps.map((t: { value: string }) => t.value)).toEqual(['203.0.113.0/24', '2001:db8::1']);

      const del = await call(tokenA, 'DELETE', `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips/${created.json().data.id}`);
      expect(del.statusCode).toBe(200);
      expect(reconcile).toHaveBeenCalledTimes(3);
      const after = await call(tokenA, 'GET', `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips`);
      expect(after.json().data.trustedIps.map((t: { value: string }) => t.value)).toEqual(['2001:db8::1']);
    });

    it('refuses a duplicate (in any spelling), a too-wide network, a loopback and the 21st entry', async () => {
      const url = `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips`;
      expect((await call(tokenA, 'POST', url, { value: '203.0.113.7' })).statusCode).toBe(200);
      const dup = await call(tokenA, 'POST', url, { value: '203.0.113.7/32' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('DUPLICATE');
      const wide = await call(tokenA, 'POST', url, { value: '203.0.0.0/16' });
      expect(wide.statusCode).toBe(400);
      expect(wide.json().error.message).toMatch(/too wide/);
      expect((await call(tokenA, 'POST', url, { value: '127.0.0.1' })).statusCode).toBe(400);
      expect((await call(tokenA, 'POST', url, { value: 'office' })).statusCode).toBe(400);
      for (let i = 1; i < 20; i += 1) {
        expect((await call(tokenA, 'POST', url, { value: `198.51.100.${i}` })).statusCode).toBe(200);
      }
      const over = await call(tokenA, 'POST', url, { value: '198.51.100.200' });
      expect(over.statusCode).toBe(409);
      expect(over.json().error.code).toBe('OVER_CAPACITY');
    });

    it('another tenant can neither read, add to nor remove from a route it does not own', async () => {
      const created = await call(tokenA, 'POST', `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips`, { value: '203.0.113.7' });
      const id = created.json().data.id as string;
      expect((await call(tokenB, 'GET', `/tenants/${ids.b}/routes/${ids.routeA}/waf-trusted-ips`)).statusCode).toBe(404);
      expect((await call(tokenB, 'POST', `/tenants/${ids.b}/routes/${ids.routeA}/waf-trusted-ips`, { value: '192.0.2.1' })).statusCode).toBe(404);
      expect((await call(tokenB, 'DELETE', `/tenants/${ids.b}/routes/${ids.routeA}/waf-trusted-ips/${id}`)).statusCode).toBe(404);
      // Its own route, another tenant's entry id.
      expect((await call(tokenB, 'DELETE', `/tenants/${ids.b}/routes/${ids.routeB}/waf-trusted-ips/${id}`)).statusCode).toBe(404);
      expect((await call(tokenB, 'GET', `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips`)).statusCode).toBe(403);
    });

    it('a wildcard route is refused: no host regex covers only what it serves', async () => {
      const res = await call(tokenA, 'POST', `/tenants/${ids.a}/routes/${ids.routeWild}/waf-trusted-ips`, { value: '203.0.113.7' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('WILDCARD_ROUTE');
    });

    it('the reconciler renders each route with its current hostname, in a stable order', async () => {
      await call(tokenA, 'POST', `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips`, { value: '198.51.100.9' });
      await call(tokenA, 'POST', `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips`, { value: '192.0.2.4' });
      await call(tokenB, 'POST', `/tenants/${ids.b}/routes/${ids.routeB}/waf-trusted-ips`, { value: '203.0.113.7' });
      await db().execute(sql`UPDATE ingress_routes SET hostname = 'www.a.example.test' WHERE id = ${ids.routeA}`);
      expect(await listTrustedIpsForReconciler(db())).toEqual([
        { routeId: ids.routeB, hostname: 'b.example.test', values: ['203.0.113.7'] },
        { routeId: ids.routeA, hostname: 'www.a.example.test', values: ['192.0.2.4', '198.51.100.9'] },
      ]);
    });
  });

  describe('the scraper', () => {
    /** A modsec pod whose audit-redactor container holds `records`. */
    const k8s = (records: string[]): K8sClients => ({
      core: {
        listNamespacedPod: async () => ({ items: [{ metadata: { name: 'modsec-crs-0' } }] }),
        readNamespacedPodLog: async ({ container }: { container: string }) => (container === 'audit-redactor' ? records.join('\n') : ''),
      },
    } as unknown as K8sClients);
    const record = (uid: string, host: string, ip: string, interrupted: boolean, rules: string[]) => JSON.stringify({
      transaction: {
        client_ip: '10.42.0.5', unique_id: uid, is_interrupted: interrupted,
        request: { method: 'POST', uri: '/mcp', headers: { 'X-Forwarded-Host': host, 'X-Real-Ip': ip } },
        response: { http_code: interrupted ? 403 : 200 },
        messages: rules.map((ruleId) => ({ message: `rule ${ruleId}`, details: { ruleId, severity: '2' } })),
      },
    });

    it('records why a request matching rules was let through, and never for a refused one', async () => {
      await call(tokenA, 'POST', `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips`, { value: '198.51.100.0/24' });
      const res = await scrapeWafLogs(db(), k8s([
        record('1.1', 'a.example.test', '203.0.113.7', false, ['941100', '949110']), // platform allowlist
        record('2.2', 'a.example.test', '198.51.100.9', false, ['941100', '949110']), // trusted on this route
        record('3.3', 'b.example.test', '198.51.100.9', false, ['941100', '949110']), // not trusted on b
        record('4.4', 'a.example.test', '192.0.2.50', false, ['920350']), // below threshold
        record('5.5', 'a.example.test', '203.0.113.7', true, ['941100', '949110']), // refused anyway
      ]), 35, async () => addressMatcher(['203.0.113.7']));
      expect(res.errors).toEqual([]);
      const rows = (await db().execute(sql`SELECT event_key, route_id, pass_reason FROM waf_logs ORDER BY event_key`)) as unknown as {
        rows: Array<{ event_key: string; route_id: string | null; pass_reason: string | null }>;
      };
      expect(rows.rows.map((r) => [r.event_key, r.pass_reason])).toEqual([
        ['1.1:941100', 'allowlisted_ip'],
        ['2.2:941100', 'trusted_ip'],
        ['3.3:941100', 'not_enforced'],
        ['4.4:920350', 'below_threshold'],
        ['5.5:941100', null],
      ]);
      expect(rows.rows.find((r) => r.event_key === '3.3:941100')?.route_id).toBe(ids.routeB);
    });

    it('a re-read keeps the first reason, and an unreadable allowlist falls back without failing', async () => {
      const lines = [record('6.6', 'a.example.test', '203.0.113.7', false, ['941100', '949110'])];
      await scrapeWafLogs(db(), k8s(lines), 35, async () => null);
      await scrapeWafLogs(db(), k8s(lines), 35, async () => addressMatcher(['203.0.113.7']));
      const [r] = (await db().execute(sql`SELECT pass_reason FROM waf_logs`) as unknown as { rows: Array<{ pass_reason: string }> }).rows;
      expect(r?.pass_reason).toBe('not_enforced');
    });

    it('a host served by a wildcard route lands in that route\'s log', async () => {
      await scrapeWafLogs(db(), k8s([
        record('7.7', 'shop.sites.a.example.test', '192.0.2.8', true, ['941100']),
        record('8.8', 'a.example.test', '192.0.2.8', true, ['941100']),
      ]), 35, async () => null);
      const rows = (await db().execute(sql`SELECT event_key, route_id, tenant_id FROM waf_logs ORDER BY event_key`)) as unknown as {
        rows: Array<{ event_key: string; route_id: string; tenant_id: string }>;
      };
      expect(rows.rows).toEqual([
        { event_key: '7.7:941100', route_id: ids.routeWild, tenant_id: ids.a },
        { event_key: '8.8:941100', route_id: ids.routeA, tenant_id: ids.a },
      ]);
    });
  });

  describe('the route\'s event list and source view', () => {
    beforeEach(async () => {
      const base = Date.now();
      const rows = [
        row({ eventKey: 'tx1:941100', passReason: 'allowlisted_ip', createdAt: new Date(base - 60_000) }),
        row({ eventKey: 'tx1:942100', ruleId: '942100', passReason: 'allowlisted_ip', createdAt: new Date(base - 60_000) }),
        row({ eventKey: 'tx2:941100', passReason: 'allowlisted_ip', createdAt: new Date(base - 50_000) }),
        row({ eventKey: 'tx3:930120', ruleId: '930120', sourceIp: '198.51.100.9', requestUri: '/x?y=1', createdAt: new Date(base - 40_000) }),
        row({ eventKey: 'tx3:949110', ruleId: '949110', sourceIp: '198.51.100.9', requestUri: '/x?y=1', createdAt: new Date(base - 40_000) }),
        row({ eventKey: 'tx4:941100', sourceIp: '192.0.2.5', detectionOnly: true, severity: 'warning', createdAt: new Date(base - 30_000) }),
        row({ routeId: ids.routeB, tenantId: ids.b, hostname: 'b.example.test', eventKey: 'txb:941100', createdAt: new Date(base - 20_000) }),
      ];
      await db().insert(wafLogs).values(rows);
    });

    const list = async (query: string) => {
      const res = await call(tokenA, 'GET', `/tenants/${ids.a}/routes/${ids.routeA}/waf-logs?${query}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { data: Array<{ id: string; sourceIp: string; ruleId: string; passReason: string | null; detectionOnly: boolean }>; pagination: { cursor: string | null; has_more: boolean; total_count: number } };
    };

    it('newest first, with the pass reason, paged by cursor without a gap or a repeat', async () => {
      const first = await list('limit=4');
      expect(first.pagination).toMatchObject({ has_more: true, total_count: 6 });
      expect(first.data[0]).toMatchObject({ sourceIp: '192.0.2.5', detectionOnly: true, passReason: null });
      const second = await list(`limit=4&cursor=${encodeURIComponent(first.pagination.cursor!)}`);
      expect(second.pagination.has_more).toBe(false);
      const ids6 = [...first.data, ...second.data].map((r) => r.id);
      expect(new Set(ids6).size).toBe(6);
      expect(second.data.at(-1)).toMatchObject({ ruleId: expect.any(String), passReason: 'allowlisted_ip' });
    });

    it('filters by source IP, rule, path (without its query) and outcome', async () => {
      expect((await list('sourceIp=198.51.100.9')).data.map((r) => r.ruleId).sort()).toEqual(['930120', '949110']);
      expect((await list('ruleId=942100')).pagination.total_count).toBe(1);
      expect((await list('path=%2Fx')).pagination.total_count).toBe(2);
      expect((await list('outcome=not_blocked')).pagination.total_count).toBe(4);
      expect((await list('outcome=blocked')).data.map((r) => r.ruleId).sort()).toEqual(['930120', '949110']);
    });

    it('sorts on the server and refuses a bad sort, filter or cursor with 400', async () => {
      const byIp = await list('sort=sourceIp:asc&limit=100');
      expect(byIp.data.map((r) => r.sourceIp)).toEqual([...byIp.data.map((r) => r.sourceIp)].sort());
      for (const q of ['sort=message:asc', 'sourceIp=1.2.3.4%25', 'ruleId=94x', 'path=x', 'cursor=not-a-cursor', 'limit=500']) {
        const res = await call(tokenA, 'GET', `/tenants/${ids.a}/routes/${ids.routeA}/waf-logs?${q}`);
        expect(res.statusCode, q).toBe(400);
      }
    });

    it('another tenant cannot read the route\'s events or sources', async () => {
      expect((await call(tokenB, 'GET', `/tenants/${ids.b}/routes/${ids.routeA}/waf-logs`)).statusCode).toBe(404);
      expect((await call(tokenB, 'GET', `/tenants/${ids.b}/routes/${ids.routeA}/waf-logs/sources`)).statusCode).toBe(404);
    });

    it('groups by source: requests, how many passed and why, top rules, and whether the route trusts it', async () => {
      await call(tokenA, 'POST', `/tenants/${ids.a}/routes/${ids.routeA}/waf-trusted-ips`, { value: '198.51.100.0/24' });
      const res = await call(tokenA, 'GET', `/tenants/${ids.a}/routes/${ids.routeA}/waf-logs/sources?sinceSeconds=86400`);
      expect(res.statusCode, res.body).toBe(200);
      const rows = res.json().data.rows as Array<Record<string, unknown>>;
      expect(rows.map((r) => [r.sourceIp, r.requests, r.notBlocked, r.trusted])).toEqual([
        ['203.0.113.7', 2, 2, false],
        ['192.0.2.5', 1, 1, false],
        ['198.51.100.9', 1, 0, true],
      ]);
      expect(rows[0]).toMatchObject({ passReasons: ['allowlisted_ip'], topRules: ['941100', '942100'], paths: 1 });
      expect(rows[2]).toMatchObject({ topRules: ['930120'], passReasons: [] });
    });

    it('the summary names the top addresses of each rule and path and counts what passed', async () => {
      const res = await call(tokenA, 'GET', `/tenants/${ids.a}/routes/${ids.routeA}/waf-logs/summary?sinceSeconds=86400`);
      const summary = res.json().data;
      expect(summary).toMatchObject({ requests: 4, notBlocked: 3 });
      const mcp = summary.rows.find((r: { ruleId: string; path: string }) => r.ruleId === '941100' && r.path === '/mcp');
      expect(mcp).toMatchObject({ requests: 3, notBlocked: 3, detectionOnly: 1, sourceIps: 2 });
      expect(mcp.topSourceIps).toEqual([{ sourceIp: '203.0.113.7', requests: 2 }, { sourceIp: '192.0.2.5', requests: 1 }]);
    });
  });

  describe('the one-off backfill', () => {
    it('marks an allowlisted address\'s rows logged after it was allowlisted and never refused, once', async () => {
      const ago = (min: number) => new Date(Date.now() - min * 60_000);
      await db().insert(wafLogs).values([
        row({ eventKey: 'old1:941100', createdAt: ago(30) }),
        row({ eventKey: 'old2:941100', createdAt: ago(30) }),
        row({ eventKey: 'old2:949110', ruleId: '949110', createdAt: ago(30) }), // refused: keeps its rows
        row({ eventKey: 'old3:941100', sourceIp: '198.51.100.9', createdAt: ago(30) }), // not allowlisted
        row({ eventKey: 'old4:930120', ruleId: '930120', createdAt: ago(300) }), // before the address was allowlisted
        row({ eventKey: 'old5:941100', sourceIp: '192.0.2.77', createdAt: ago(30) }), // entry of unknown age
      ]);
      const entries = [
        { value: '203.0.113.0/24', addedAt: ago(120).toISOString() },
        { value: '192.0.2.77', addedAt: null },
      ];
      expect(await backfillAllowlistedPassReasons(db(), async () => null)).toEqual({ ran: false, updated: 0, done: false });
      expect(await backfillAllowlistedPassReasons(db(), async () => entries)).toEqual({ ran: true, updated: 1, done: true });
      const rows = (await db().execute(sql`SELECT event_key, pass_reason FROM waf_logs ORDER BY event_key`)) as unknown as {
        rows: Array<{ event_key: string; pass_reason: string | null }>;
      };
      expect(rows.rows).toEqual([
        { event_key: 'old1:941100', pass_reason: 'allowlisted_ip' },
        { event_key: 'old2:941100', pass_reason: null },
        { event_key: 'old2:949110', pass_reason: null },
        { event_key: 'old3:941100', pass_reason: null },
        { event_key: 'old4:930120', pass_reason: null },
        { event_key: 'old5:941100', pass_reason: null },
      ]);
      await db().insert(wafLogs).values(row({ eventKey: 'later:941100' }));
      const load = vi.fn(async () => entries);
      expect(await backfillAllowlistedPassReasons(db(), load)).toEqual({ ran: false, updated: 0, done: true });
      expect(load).not.toHaveBeenCalled();
    });
  });
});
