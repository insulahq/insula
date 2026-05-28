/**
 * Auth + ownership tests for the tenant-scoped restore routes.
 *
 * Three security boundaries we MUST pin:
 *   1. No token → 401
 *   2. Admin-panel token (panel='admin') → 403 (wrong panel)
 *   3. Tenant token with mismatched :tenantId in path → 403
 *      (CLIENT_ACCESS_DENIED)
 *
 * Policy enforcement is unit-tested in tenant-restore-policy.test.ts;
 * here we verify the validator wires through the route layer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const { tenantRestoreRoutes } = await import('./tenant-routes.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

describe('tenant-routes auth boundaries', () => {
  let app: FastifyInstance;
  let tenantAToken: string;
  let tenantBToken: string;
  let adminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    // Minimal db stub. Every chainable method returns a thenable that
    // resolves to []. The auth-boundary tests don't depend on row
    // content — they only need the route's DB-call chain to not throw.
    const makeChain = (): unknown => {
      const chain: Record<string, unknown> = {};
      const methods = ['select', 'from', 'innerJoin', 'where', 'limit', 'orderBy', 'set', 'returning'];
      for (const m of methods) chain[m] = () => makeChain();
      chain.then = (resolve: (v: unknown) => void) => resolve([]);
      return chain;
    };
    app.decorate('db', makeChain() as unknown as never);
    await app.register(tenantRestoreRoutes, { prefix: '/api/v1' });
    await app.ready();

    tenantAToken = app.jwt.sign({
      sub: 'user-a',
      role: 'tenant_admin',
      panel: 'tenant',
      tenantId: TENANT_A,
      iat: Math.floor(Date.now() / 1000),
    });
    tenantBToken = app.jwt.sign({
      sub: 'user-b',
      role: 'tenant_admin',
      panel: 'tenant',
      tenantId: TENANT_B,
      iat: Math.floor(Date.now() / 1000),
    });
    adminToken = app.jwt.sign({
      sub: 'admin-1',
      role: 'super_admin',
      panel: 'admin',
      iat: Math.floor(Date.now() / 1000),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /tenants/:tenantId/bundles requires authentication (401 without token)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/tenants/${TENANT_A}/bundles` });
    expect(res.statusCode).toBe(401);
  });

  it('GET /tenants/:tenantId/bundles rejects admin-panel token (wrong panel)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${TENANT_A}/bundles`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /tenants/:tenantId/bundles allows own-tenant tenant_admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${TENANT_A}/bundles`,
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /tenants/B/bundles with tenant A token → 403 (cross-tenant)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${TENANT_B}/bundles`,
      headers: { authorization: `Bearer ${tenantAToken}` },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error?: { code?: string } };
    expect(body.error?.code).toBe('CLIENT_ACCESS_DENIED');
  });

  it('POST /tenants/:tenantId/restore-carts (mutate) rejects tenant_user role', async () => {
    const tenantUserToken = app.jwt.sign({
      sub: 'user-readonly',
      role: 'tenant_user',
      panel: 'tenant',
      tenantId: TENANT_A,
      iat: Math.floor(Date.now() / 1000),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${TENANT_A}/restore-carts`,
      headers: { authorization: `Bearer ${tenantUserToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ tenantId: TENANT_A }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /tenants/A/restore-carts with body.tenantId=B → 400 (mismatch)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${TENANT_A}/restore-carts`,
      headers: { authorization: `Bearer ${tenantAToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ tenantId: TENANT_B }),
    });
    expect(res.statusCode).toBe(400);
  });
});
