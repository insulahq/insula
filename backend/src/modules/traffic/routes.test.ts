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

/** Namespaces nested inside NS_A; swapped per test. */
let nestedRows: Array<{ nested: string }> = [];

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
      const keys = cols ? Object.keys(cols) : [];
      // Three different selects reach this fake, told apart by their shape:
      // the namespace lookup (`ns`), the nested-namespace check (`nested`),
      // and the display-name map (two columns).
      if (keys.length === 1 && keys[0] === 'nested') pending = nestedRows;
      else if (keys.length === 1) pending = [{ ns: NS_A }];
      else pending = [{ ns: NS_A, name: 'Alpha Ltd' }, { ns: NS_B, name: 'Beta Ltd' }];
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

  // A tenant's traffic is measured at the INGRESS now, so isolation is
  // carried by the service matcher rather than a namespace label.
  it('serves a tenant their own traffic', async () => {
    const res = await tenantSeries('scope=tenant&metric=traffic');
    expect(res.statusCode).toBe(200);
    expect(asked.every((e) => e.includes(`service=~"${NS_A}-.+"`))).toBe(true);
  });

  it('IGNORES a subject naming another tenant', async () => {
    // The client may send anything; the handler uses the path tenant only.
    const res = await tenantSeries(`scope=tenant&subject=${NS_B}`);
    expect(res.statusCode).toBe(200);
    expect(asked.join(' ')).toContain(`service=~"${NS_A}-.+"`);
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

describe('tenant route scope (was entirely non-functional)', () => {
  let app2: FastifyInstance;
  let token: string;
  beforeAll(async () => {
    app2 = Fastify();
    await app2.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app2);
    app2.setErrorHandler(errorHandler);
    app2.decorate('db', makeDb() as never);
    await app2.register(trafficRoutes, { prefix: '/api/v1' });
    await app2.ready();
    token = app2.jwt.sign({
      sub: 'u-a', role: 'tenant_admin', panel: 'tenant', tenantId: TENANT_A,
      iat: Math.floor(Date.now() / 1000),
    });
  });
  afterAll(async () => { await app2.close(); });

  const call = (path: string) => {
    asked = [];
    return app2.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}` } });
  };

  it('matches the tenant’s services by namespace, not by the bare namespace', async () => {
    // `service="tenant-alpha-ns"` can never match: a Traefik service label is
    // `<namespace>-<ingress>-<hash>@kubernetescrd`. It selected nothing and
    // rendered an empty chart that read as "you have no traffic".
    const res = await call(`/api/v1/tenants/${TENANT_A}/traffic/series?from=${FROM}&to=${TO}&scope=route`);
    expect(res.statusCode).toBe(200);
    expect(asked.join(' ')).toContain(`service=~"${NS_A}-.+"`);
    expect(asked.join(' ')).not.toContain(`service="${NS_A}"`);
  });

  it('lists a tenant’s individual routes instead of returning nothing', async () => {
    const res = await call(`/api/v1/tenants/${TENANT_A}/traffic/subjects?from=${FROM}&to=${TO}&scope=route`);
    expect(res.statusCode).toBe(200);
    // Grouping by service is what makes the picker a list; forcing a subject
    // collapsed it to one line and the picker came back empty.
    expect(asked.join(' ')).toContain('sum by (service)');
  });

  it('accepts a route that belongs to the tenant', async () => {
    const own = `${NS_A}-web-abc@kubernetescrd`;
    const res = await call(
      `/api/v1/tenants/${TENANT_A}/traffic/series?from=${FROM}&to=${TO}&scope=route&subject=${encodeURIComponent(own)}`,
    );
    expect(res.statusCode).toBe(200);
    expect(asked.join(' ')).toContain(`service="${own}"`);
  });

  it('DROPS a route of a NESTED namespace, which the prefix test alone allows', async () => {
    // `tenant-alpha-ns` and `tenant-alpha-ns-eu-ns` are both legal namespaces
    // and the second begins with the first plus a hyphen, so a string-prefix
    // ownership test hands the inner tenant's routes to the outer one. The
    // trailing hyphen does not help here — only the real namespace list does.
    nestedRows = [{ nested: `${NS_A}-eu-ns` }];
    const theirs = `${NS_A}-eu-ns-web-abc@kubernetescrd`;
    expect(theirs.startsWith(`${NS_A}-`)).toBe(true); // the prefix test would pass
    const res = await call(
      `/api/v1/tenants/${TENANT_A}/traffic/series?from=${FROM}&to=${TO}&scope=route&subject=${encodeURIComponent(theirs)}`,
    );
    expect(res.statusCode).toBe(200);
    expect(asked.join(' ')).not.toContain(`service="${theirs}"`);
    expect(asked.join(' ')).toContain(`service=~"${NS_A}-.+"`);
    nestedRows = [];
  });

  it('still accepts the tenant’s own route when a nested namespace exists', async () => {
    nestedRows = [{ nested: `${NS_A}-eu-ns` }];
    const own = `${NS_A}-web-abc@kubernetescrd`;
    const res = await call(
      `/api/v1/tenants/${TENANT_A}/traffic/series?from=${FROM}&to=${TO}&scope=route&subject=${encodeURIComponent(own)}`,
    );
    expect(res.statusCode).toBe(200);
    expect(asked.join(' ')).toContain(`service="${own}"`);
    nestedRows = [];
  });

  it('DROPS a route belonging to somebody else rather than querying it', async () => {
    const other = `${NS_B}-web-abc@kubernetescrd`;
    const res = await call(
      `/api/v1/tenants/${TENANT_A}/traffic/series?from=${FROM}&to=${TO}&scope=route&subject=${encodeURIComponent(other)}`,
    );
    expect(res.statusCode).toBe(200);
    expect(asked.join(' ')).not.toContain(NS_B);
    expect(asked.join(' ')).toContain(`service=~"${NS_A}-.+"`);
  });

  it('serves route traffic rather than 400ing on the default metric', async () => {
    const res = await call(`/api/v1/tenants/${TENANT_A}/traffic/series?from=${FROM}&to=${TO}&scope=route&metric=traffic`);
    expect(res.statusCode).toBe(200);
    expect(asked.join(' ')).toMatch(/traefik_service_(responses|requests)_bytes_total/);
  });
});

describe('admin subject validation', () => {
  let app3: FastifyInstance;
  let adminTok: string;
  beforeAll(async () => {
    app3 = Fastify();
    await app3.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app3);
    app3.setErrorHandler(errorHandler);
    app3.decorate('db', makeDb() as never);
    await app3.register(trafficRoutes, { prefix: '/api/v1' });
    await app3.ready();
    adminTok = app3.jwt.sign({ sub: 'op', role: 'admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });
  afterAll(async () => { await app3.close(); });

  it('refuses a subject that only LOOKS like a namespace', async () => {
    // `startsWith('tenant-')` was the whole check, so any string beginning
    // with those characters reached the query builder.
    asked = [];
    const evil = encodeURIComponent('tenant-x", job=~".+');
    const res = await app3.inject({
      method: 'GET',
      url: `/api/v1/admin/monitoring/traffic/subjects?from=${FROM}&to=${TO}&scope=tenant&subject=${evil}`,
      headers: { authorization: `Bearer ${adminTok}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TRAFFIC_QUERY');
    expect(asked).toHaveLength(0);
  });
});
