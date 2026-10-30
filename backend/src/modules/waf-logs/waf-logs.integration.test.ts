/**
 * WAF event retention and the "would block" summary, on real Postgres:
 * the setting, age pruning, the flood ceiling (which must never take rows
 * auto-ban still has to judge), the grouping, and the four endpoints —
 * including that a tenant sees only its own route.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import { closeTestDb, cleanTables, getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { seedDomain, seedPlan, seedRegion, seedTenant } from '../../test-helpers/fixtures.js';
import { ingressRoutes } from '../../db/schema.js';
import {
  ADMIN_HOST_CEILING,
  BATCH,
  PROTECTED_RECENT_SECONDS,
  RETENTION_SETTING_KEY,
  ROUTE_CEILING,
  loadRetentionDays,
  pruneWafLogs,
  saveRetentionDays,
} from './retention.js';
import { summarizeForRoute } from './summary.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('WAF event retention and summary (integration)', () => {
  const db = () => getTestDb();
  let app: FastifyInstance;
  const ids = { a: '', b: '', routeA: '', routeB: '' };
  let adminToken = '';
  let tokenA = '';
  let tokenB = '';

  /** n rows on a route (or the platform hosts, routeId null), `ageSeconds` old. */
  const insertRows = (routeId: string | null, n: number, ageSeconds: number, over: { rule?: string; uri?: string; ip?: string; detect?: boolean; host?: string } = {}) =>
    db().execute(sql`
      INSERT INTO waf_logs (id, route_id, tenant_id, hostname, rule_id, severity, message, request_uri, request_method, source_ip, detection_only, created_at)
      SELECT gen_random_uuid()::text, ${routeId}, NULL, ${over.host ?? 'a.example.test'}, ${over.rule ?? '941100'}, 'critical', 'XSS Attack Detected',
             ${over.uri ?? '/mod/forum/post.php?x=1'}, 'POST', ${over.ip ?? '192.0.2.10'}, ${over.detect ?? false},
             now() - make_interval(secs => ${ageSeconds}) - make_interval(secs => g * 0.001)
        FROM generate_series(1, ${n}) AS g`);
  const count = async (where = sql`TRUE`) =>
    Number(((await db().execute(sql`SELECT count(*)::int AS n FROM waf_logs WHERE ${where}`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);

  beforeAll(async () => {
    await runMigrations();
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', getTestDb());
    const { wafLogRoutes } = await import('./routes.js');
    await app.register(wafLogRoutes, { prefix: '/api/v1' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql`DELETE FROM waf_logs`);
    await db().execute(sql`DELETE FROM platform_settings WHERE setting_key = ${RETENTION_SETTING_KEY}`);
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    for (const [key, host] of [['a', 'a.example.test'], ['b', 'b.example.test']] as const) {
      const tenant = await seedTenant(db(), region.id, plan.id);
      const domain = await seedDomain(db(), tenant.id, { domainName: host });
      const routeId = randomUUID();
      await db().insert(ingressRoutes).values({ id: routeId, domainId: domain.id, hostname: host, ingressCname: 'unused.example.test' });
      ids[key] = tenant.id;
      ids[key === 'a' ? 'routeA' : 'routeB'] = routeId;
    }
    const iat = Math.floor(Date.now() / 1000);
    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat });
    tokenA = app.jwt.sign({ sub: 'ua', role: 'tenant_admin', panel: 'tenant', tenantId: ids.a, iat });
    tokenB = app.jwt.sign({ sub: 'ub', role: 'tenant_admin', panel: 'tenant', tenantId: ids.b, iat });
  });

  describe('retention setting', () => {
    it('defaults to 30 days, keeps a saved value, and ignores a stored value out of range', async () => {
      expect(await loadRetentionDays(db())).toBe(30);
      await saveRetentionDays(db(), 7);
      expect(await loadRetentionDays(db())).toBe(7);
      for (const bad of ['0', '366', 'abc', '7.5']) {
        await db().execute(sql`UPDATE platform_settings SET setting_value = ${bad} WHERE setting_key = ${RETENTION_SETTING_KEY}`);
        expect(await loadRetentionDays(db()), bad).toBe(30);
      }
    });
  });

  describe('pruneWafLogs', () => {
    it('removes rows older than the retention and keeps the rest', async () => {
      await insertRows(ids.routeA, 3, 40 * 86_400);
      await insertRows(ids.routeA, 2, 10 * 86_400);
      await insertRows(null, 4, 31 * 86_400, { host: 'admin.example.test' });
      expect((await pruneWafLogs(db())).aged).toBe(7);
      expect(await count()).toBe(2);
      await saveRetentionDays(db(), 7);
      expect((await pruneWafLogs(db())).aged).toBe(2);
      expect(await count()).toBe(0);
    });

    it('works off more rows than one batch, and keeps a row just inside the retention', async () => {
      await insertRows(ids.routeA, 2 * BATCH + 1_000, 31 * 86_400);
      await insertRows(ids.routeA, 1, 30 * 86_400 - 3600);
      expect((await pruneWafLogs(db())).aged).toBe(2 * BATCH + 1_000);
      expect(await count()).toBe(1);
    });

    it('a route over its ceiling loses its oldest rows, down to the ceiling', async () => {
      await insertRows(ids.routeA, ROUTE_CEILING, 2 * 3600);
      await insertRows(ids.routeA, 150, 3 * 3600, { uri: '/oldest' });
      await insertRows(ids.routeB, 10, 3 * 3600);
      const res = await pruneWafLogs(db());
      expect(res.overCeiling).toBe(150);
      expect(await count(sql`route_id = ${ids.routeA}`)).toBe(ROUTE_CEILING);
      expect(await count(sql`request_uri = '/oldest'`)).toBe(0);
      expect(await count(sql`route_id = ${ids.routeB}`)).toBe(10);
    });

    it('never removes rows auto-ban still has to judge, even in a flood over the ceiling', async () => {
      // A flood: every row younger than the protected window.
      await insertRows(ids.routeA, ROUTE_CEILING + 500, 60);
      expect((await pruneWafLogs(db())).overCeiling).toBe(0);
      expect(await count()).toBe(ROUTE_CEILING + 500);
      // Once it ages past the window, the next run trims it.
      expect((await pruneWafLogs(db(), { shiftSeconds: PROTECTED_RECENT_SECONDS + 120 })).overCeiling).toBe(500);
    });

    it('the protection follows auto-ban\'s window when an operator widens it', async () => {
      await db().execute(sql`INSERT INTO platform_settings (setting_key, setting_value) VALUES ('security.crowdsec.autoban_window_seconds', '3600')
        ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`);
      try {
        // 30 minutes old: past the 15-minute floor, inside the hour auto-ban now reads back.
        await insertRows(ids.routeA, ROUTE_CEILING + 100, 30 * 60);
        expect((await pruneWafLogs(db())).overCeiling).toBe(0);
        const settings = await app.inject({ method: 'GET', url: '/api/v1/admin/security/waf-log-settings', headers: { authorization: `Bearer ${adminToken}` } });
        expect(settings.json().data.protectedRecentMinutes).toBe(70);
      } finally {
        await db().execute(sql`DELETE FROM platform_settings WHERE setting_key = 'security.crowdsec.autoban_window_seconds'`);
      }
    });

    it('the platform hosts share one ceiling of their own', async () => {
      await insertRows(null, ADMIN_HOST_CEILING + 20, 3600, { host: 'admin.example.test' });
      await insertRows(ids.routeA, 5, 3600);
      expect((await pruneWafLogs(db())).overCeiling).toBe(20);
      expect(await count(sql`route_id IS NULL`)).toBe(ADMIN_HOST_CEILING);
      expect(await count(sql`route_id = ${ids.routeA}`)).toBe(5);
    });
  });

  describe('summary', () => {
    const seedEvents = async () => {
      // Four requests: three on the forum page (941100 + 941160 each), one H5P beacon (920420).
      for (let i = 0; i < 3; i += 1) {
        await insertRows(ids.routeA, 1, 600 + i, { rule: '941100', ip: `192.0.2.${10 + (i % 2)}`, detect: i === 0 });
        await insertRows(ids.routeA, 1, 600 + i, { rule: '941160', ip: `192.0.2.${10 + (i % 2)}`, detect: i === 0 });
        await insertRows(ids.routeA, 1, 600 + i, { rule: '949110' });
      }
      await insertRows(ids.routeA, 1, 700, { rule: '920420', uri: '/lib/ajax/service.php?sesskey=abc' });
      await insertRows(ids.routeA, 1, 700, { rule: '949110', uri: '/lib/ajax/service.php?sesskey=abc' });
      // Outside a one-day window, and another tenant's route.
      await insertRows(ids.routeA, 1, 3 * 86_400, { rule: '942100', uri: '/old' });
      await insertRows(ids.routeB, 2, 600, { rule: '930130', host: 'b.example.test', uri: '/.env' });
    };

    it('groups a route\'s events by rule and path, without the scoring rule', async () => {
      await seedEvents();
      const s = await summarizeForRoute(db(), ids.routeA, 86_400);
      expect(s.requests).toBe(4);
      expect(s.truncated).toBe(false);
      // Most requests first (ties: most recent first).
      expect(s.rows.map((r) => r.requests)).toEqual([3, 3, 1]);
      expect(s.rows.map((r) => [r.ruleId, r.path, r.requests, r.detectionOnly, r.sourceIps]).sort()).toEqual([
        ['920420', '/lib/ajax/service.php', 1, 0, 1],
        ['941100', '/mod/forum/post.php', 3, 1, 2],
        ['941160', '/mod/forum/post.php', 3, 1, 2],
      ]);
      expect((await summarizeForRoute(db(), ids.routeA, 7 * 86_400)).rows.map((r) => r.path)).toContain('/old');
    });

    it('a URI with no path before its query string counts as "/", in one group with "/"', async () => {
      await insertRows(ids.routeA, 2, 600, { rule: '930130', uri: '?x=1' });
      await insertRows(ids.routeA, 3, 600, { rule: '930130', uri: '/' });
      const s = await summarizeForRoute(db(), ids.routeA, 86_400);
      expect(s.rows.map((r) => [r.path, r.requests])).toEqual([['/', 5]]);
    });

    it('tenant endpoint: the owner gets its route, another tenant gets 404', async () => {
      await seedEvents();
      const url = `/api/v1/tenants/${ids.a}/routes/${ids.routeA}/waf-logs/summary?sinceSeconds=86400`;
      const own = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokenA}` } });
      expect(own.statusCode).toBe(200);
      expect(own.json().data.rows).toHaveLength(3);
      const other = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/${ids.b}/routes/${ids.routeA}/waf-logs/summary`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(other.statusCode).toBe(404);
      expect(other.body).not.toContain('forum');
      const badWindow = await app.inject({ method: 'GET', url: `${url.split('?')[0]}?sinceSeconds=60`, headers: { authorization: `Bearer ${tokenA}` } });
      expect(badWindow.statusCode).toBe(400);
    });

    it('admin endpoint: across hosts, narrowed by the WAF Events filters', async () => {
      await seedEvents();
      const all = await app.inject({ method: 'GET', url: '/api/v1/admin/security/waf-events/summary?sinceSeconds=86400', headers: { authorization: `Bearer ${adminToken}` } });
      expect(all.statusCode).toBe(200);
      expect(all.json().data.rows.map((r: { hostname: string }) => r.hostname)).toContain('b.example.test');
      const one = await app.inject({ method: 'GET', url: '/api/v1/admin/security/waf-events/summary?sinceSeconds=86400&host=b.example', headers: { authorization: `Bearer ${adminToken}` } });
      expect(one.json().data.rows).toEqual([expect.objectContaining({ hostname: 'b.example.test', ruleId: '930130', path: '/.env', requests: 2 })]);
      const asTenant = await app.inject({ method: 'GET', url: '/api/v1/admin/security/waf-events/summary', headers: { authorization: `Bearer ${tokenA}` } });
      expect(asTenant.statusCode).toBe(403);
    });
  });

  describe('settings endpoints', () => {
    it('GET shows the retention, the ceilings and what is stored; PATCH changes the retention', async () => {
      await insertRows(ids.routeA, 3, 5 * 86_400);
      const auth = { authorization: `Bearer ${adminToken}` };
      const got = await app.inject({ method: 'GET', url: '/api/v1/admin/security/waf-log-settings', headers: auth });
      expect(got.json().data).toMatchObject({ retentionDays: 30, routeCeiling: ROUTE_CEILING, adminHostCeiling: ADMIN_HOST_CEILING, storedEvents: 3 });
      expect(Date.parse(got.json().data.oldestEventAt)).toBeLessThan(Date.now() - 4 * 86_400_000);

      const patched = await app.inject({ method: 'PATCH', url: '/api/v1/admin/security/waf-log-settings', headers: auth, payload: { retentionDays: 90 } });
      expect(patched.json().data.retentionDays).toBe(90);
      for (const bad of [0, 366, 7.5, '30']) {
        const res = await app.inject({ method: 'PATCH', url: '/api/v1/admin/security/waf-log-settings', headers: auth, payload: { retentionDays: bad } });
        expect(res.statusCode, String(bad)).toBe(400);
      }
      const asTenant = await app.inject({ method: 'PATCH', url: '/api/v1/admin/security/waf-log-settings', headers: { authorization: `Bearer ${tokenA}` }, payload: { retentionDays: 1 } });
      expect(asTenant.statusCode).toBe(403);
      expect(await loadRetentionDays(db())).toBe(90);
    });
  });
});
