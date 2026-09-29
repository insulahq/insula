/**
 * Traffic endpoints — the boundary, not the arithmetic.
 *
 * The tenant surface takes its tenant from the PATH, where
 * `requireTenantAccess` has already authorised it, and DISCARDS whatever
 * subject the client sent. These cases pin that: another tenant's namespace,
 * a scope only an operator may ask for, and the backup split that must never
 * appear on a tenant's own graph because it is not billed to them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

/** Every PromQL expression the handler asked vmsingle for, in order. */
let asked: string[] = [];
vi.mock('../monitoring/vm-client.js', () => ({
  queryRange: (expr: string) => { asked.push(expr); return Promise.resolve([]); },
  queryInstant: () => Promise.resolve([]),
}));

const { trafficRoutes } = await import('./routes.js');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const NS_A = 'tenant-alpha-ns';
const NS_B = 'tenant-beta-ns';
const NS_BY_ID: Record<string, string> = { [TENANT_A]: NS_A, [TENANT_B]: NS_B };

function makeDb(): unknown {
  let pending: unknown[] = [];
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'limit', 'orderBy']) c[m] = () => chain();
    c.then = (resolve: (v: unknown) => void) => resolve(pending);
    return c;
  };
  return {
    select: (cols?: Record<string, unknown>) => {
      // The only single-column select is the namespace lookup; the name map
      // select asks for two.
      pending = cols && Object.keys(cols).length === 1
        ? [{ ns: NS_A }]
        : [{ ns: NS_A, name: 'Alpha Ltd' }, { ns: NS_B, name: 'Beta Ltd' }];
      return chain();
    },
  };
}

const FROM = new Date(Date.now() - 6 * 3600_000).toISOString();
const TO = new Date().toISOString();

describe('traffic routes', () => {
  let app: FastifyInstance;
  let tenantToken: string;
  let adminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', makeDb() as never);
    // Resolve any tenant id to its namespace, as the real lookup does.
    await app.register(trafficRoutes, { prefix: '/api/v1' });
    await app.ready();
    const now = Math.floor(Date.now() / 1000);
    tenantToken = app.jwt.sign({ sub: 'u-a', role: 'tenant_admin', panel: 'tenant', tenantId: TENANT_A, iat: now });
    adminToken = app.jwt.sign({ sub: 'op', role: 'admin', panel: 'admin', iat: now });
  });
  afterAll(async () => { await app.close(); });

  const get = (url: string, token: string) => {
    asked = [];
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  };
  const tenantSeries = (qs: string, token = tenantToken) =>
    get(`/api/v1/tenants/${TENANT_A}/traffic/series?from=${FROM}&to=${TO}&${qs}`, token);

  it('serves a tenant their own traffic', async () => {
    const res = await tenantSeries('scope=tenant&metric=traffic');
    expect(res.statusCode).toBe(200);
    expect(asked.every((e) => e.includes(`namespace="${NS_A}"`))).toBe(true);
  });

  it('IGNORES a subject naming another tenant', async () => {
    // The client may send anything; the handler uses the path tenant only.
    const res = await tenantSeries(`scope=tenant&subject=${NS_B}`);
    expect(res.statusCode).toBe(200);
    expect(asked.join(' ')).toContain(`namespace="${NS_A}"`);
    expect(asked.join(' ')).not.toContain(NS_B);
  });

  it('refuses an operator-only scope with 403, not an empty chart', async () => {
    for (const scope of ['cluster', 'node', 'backup-class']) {
      const res = await tenantSeries(`scope=${scope}`);
      expect(res.statusCode, scope).toBe(403);
      expect(res.json().error.code).toBe('TRAFFIC_SCOPE_FORBIDDEN');
      expect(asked, scope).toHaveLength(0);
    }
  });

  it('never splits backups out on a tenant graph, even when asked', async () => {
    // Platform backups are excluded from the tenant's bill; drawing them here
    // would contradict the allowance shown right above the chart.
    const res = await tenantSeries('scope=tenant&backups=separate');
    expect(res.statusCode).toBe(200);
    expect(asked.some((e) => e.includes('bk-files-'))).toBe(false);
  });

  it('rejects one tenant reading another tenant’s endpoint', async () => {
    const res = await get(`/api/v1/tenants/${TENANT_B}/traffic/series?from=${FROM}&to=${TO}`, tenantToken);
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unauthenticated call', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/tenants/${TENANT_A}/traffic/series?from=${FROM}&to=${TO}` });
    expect(res.statusCode).toBe(401);
  });

  it('turns an impossible question into a 400 that says why', async () => {
    const res = await tenantSeries('scope=pod&metric=requests');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TRAFFIC_QUERY_UNSUPPORTED');
    expect(res.json().error.message).toMatch(/per service, not per pod/);
  });

  it('rejects a malformed range with a readable message', async () => {
    const res = await get(`/api/v1/tenants/${TENANT_A}/traffic/series?from=${TO}&to=${FROM}`, tenantToken);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TRAFFIC_QUERY');
    expect(res.json().error.message).toContain('must be after');
  });

  it('lets an operator ask for the cluster', async () => {
    const res = await get(`/api/v1/admin/monitoring/traffic/series?from=${FROM}&to=${TO}&scope=cluster`, adminToken);
    expect(res.statusCode).toBe(200);
    expect(asked.some((e) => e.includes('id="/"'))).toBe(true);
  });

  it('refuses an admin endpoint to a tenant token', async () => {
    const res = await get(`/api/v1/admin/monitoring/traffic/series?from=${FROM}&to=${TO}`, tenantToken);
    expect(res.statusCode).toBe(403);
  });
});
