import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { registerAuth, authenticate, requirePanel, requireRole, requireTenantAccess, requireTenantRoleByMethod } from './auth.js';
import { errorHandler } from './error-handler.js';

describe('auth middleware', () => {
  let app: FastifyInstance;
  let validToken: string;
  let supportToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    // Protected route requiring admin
    app.get('/admin-only', { preHandler: [authenticate, requireRole('admin')] }, async (request) => {
      return { user: request.user };
    });

    // Protected route requiring admin or support
    app.get('/admin-support', { preHandler: [authenticate, requireRole('admin', 'support')] }, async (request) => {
      return { user: request.user };
    });

    // Auth-only route (any role)
    app.get('/auth-only', { preHandler: [authenticate] }, async (request) => {
      return { user: request.user };
    });

    // Phase 6: method-aware tenant role guard test routes
    app.get('/tenant-rsrc', {
      preHandler: [authenticate, requireTenantRoleByMethod()],
    }, async () => ({ ok: true }));
    app.post('/tenant-rsrc', {
      preHandler: [authenticate, requireTenantRoleByMethod()],
    }, async () => ({ ok: true }));
    app.patch('/tenant-rsrc', {
      preHandler: [authenticate, requireTenantRoleByMethod()],
    }, async () => ({ ok: true }));
    app.delete('/tenant-rsrc', {
      preHandler: [authenticate, requireTenantRoleByMethod()],
    }, async () => ({ ok: true }));

    // Route-level skipAuth opt-out (used by signed-URL endpoints).
    // All three guards (authenticate, requirePanel, requireRole) must
    // honour the flag so a window.location GET with no Bearer can reach
    // the handler that does its own token verification.
    app.get('/no-auth-needed', {
      preHandler: [authenticate, requirePanel('admin'), requireRole('admin', 'super_admin')],
      config: { skipAuth: true },
    }, async () => ({ ok: true, viaSkipAuth: true }));

    await app.ready();

    validToken = app.jwt.sign({ sub: 'user-1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'user-2', role: 'support', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should reject request without Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth-only' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MISSING_BEARER_TOKEN');
  });

  it('should reject request with invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth-only',
      headers: { authorization: 'Bearer invalid.token.here' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  it('should accept valid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth-only',
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.sub).toBe('user-1');
    expect(res.json().user.role).toBe('admin');
  });

  it('should enforce admin role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin-only',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('should allow admin on admin-only route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin-only',
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should allow support on admin-support route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin-support',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should reject non-Bearer auth schemes (Bearer-only guard)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth-only',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MISSING_BEARER_TOKEN');
  });

  it('ignores platform_session cookie on Bearer-only routes (CSRF-safe)', async () => {
    // The shared authenticate() middleware deliberately rejects cookie-
    // only requests so that SameSite=Lax + subdomain-hosted tenant
    // content can't CSRF state-changing API calls. Cookie support lives
    // on authenticateSession() for read-only gates (see below).
    const res = await app.inject({
      method: 'GET',
      url: '/auth-only',
      headers: { cookie: `platform_session=${validToken}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MISSING_BEARER_TOKEN');
  });

  // Note: session-cookie behavior is exercised directly on the
  // verify-admin-session endpoint in modules/auth/routes.test.ts —
  // that endpoint is the only consumer of cookie-based auth and
  // handles it inline (no shared middleware). The broader
  // `authenticate` middleware stays strictly Bearer-only to keep
  // mutating routes CSRF-safe.

  describe('skipAuth route-level opt-out', () => {
    it('all three guards honour config.skipAuth (no Bearer required)', async () => {
      // No Authorization header at all — would normally 401 at authenticate.
      const res = await app.inject({ method: 'GET', url: '/no-auth-needed' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, viaSkipAuth: true });
    });

    it('skipAuth still works when a Bearer is supplied (does not error on extra info)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/no-auth-needed',
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('requireTenantRoleByMethod (Phase 6)', () => {
    const iat = Math.floor(Date.now() / 1000);
    let tenantAdminToken: string;
    let tenantUserToken: string;
    let readOnlyToken: string;
    let supportTokenLocal: string;

    beforeAll(() => {
      tenantAdminToken = app.jwt.sign({ sub: 'ca', role: 'tenant_admin', panel: 'tenant', tenantId: 'c1', iat });
      tenantUserToken = app.jwt.sign({ sub: 'cu', role: 'tenant_user', panel: 'tenant', tenantId: 'c1', iat });
      readOnlyToken = app.jwt.sign({ sub: 'ro', role: 'read_only', panel: 'admin', iat });
      supportTokenLocal = app.jwt.sign({ sub: 'sup', role: 'support', panel: 'admin', iat });
    });

    it('allows tenant_user to GET (read)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tenant-rsrc',
        headers: { authorization: `Bearer ${tenantUserToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects read_only admin on tenant resources (admin-panel role)', async () => {
      // `read_only` is for admin dashboard / metrics / health
      // aggregate reads — it should NOT have access to individual
      // tenant resource endpoints like /tenants/:id/domains.
      const res = await app.inject({
        method: 'GET',
        url: '/tenant-rsrc',
        headers: { authorization: `Bearer ${readOnlyToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects tenant_user POST (write)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tenant-rsrc',
        headers: { authorization: `Bearer ${tenantUserToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects tenant_user PATCH (write)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/tenant-rsrc',
        headers: { authorization: `Bearer ${tenantUserToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects tenant_user DELETE (write)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/tenant-rsrc',
        headers: { authorization: `Bearer ${tenantUserToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects read_only admin POST (read_only cannot write)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tenant-rsrc',
        headers: { authorization: `Bearer ${readOnlyToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows tenant_admin POST (tenant_admin can write)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tenant-rsrc',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows support POST (staff can write)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tenant-rsrc',
        headers: { authorization: `Bearer ${supportTokenLocal}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows tenant_admin DELETE', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/tenant-rsrc',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects unauthenticated requests', async () => {
      const res = await app.inject({ method: 'POST', url: '/tenant-rsrc', payload: {} });
      expect(res.statusCode).toBe(401);
    });
  });

  // 2026-05-28: regression guard for ADR-040 SYSTEM-tenant bypass.
  // The createDomain + createDnsRecord guards skip the reserved-
  // hostname check when tenant.isSystem===true. That's safe only if
  // a NON-system tenant can never get past the auth middleware with a
  // URL :tenantId pointing at the SYSTEM row. requireTenantAccess is
  // the gate that enforces this; without these tests an accidental
  // middleware regression would silently turn "skip reserved check
  // for SYSTEM" into "skip reserved check for any tenant who passes
  // the SYSTEM_TENANT_ID in the URL".
  describe('requireTenantAccess SYSTEM-tenant smuggle guard', () => {
    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000'; // arbitrary literal — represents the SYSTEM row's UUID
    let tenantApp: FastifyInstance;
    let regularTenantToken: string;
    let adminToken: string;
    let panellessToken: string;

    beforeAll(async () => {
      tenantApp = Fastify();
      await tenantApp.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
      registerAuth(tenantApp);
      tenantApp.setErrorHandler(errorHandler);

      tenantApp.post('/tenants/:tenantId/domains', {
        preHandler: [authenticate, requireTenantAccess()],
      }, async (request) => {
        const params = request.params as { tenantId: string };
        return { ok: true, tenantId: params.tenantId };
      });

      await tenantApp.ready();

      // Regular tenant user, tenantId='tenant-regular'. The token says
      // panel=tenant so requireTenantAccess WILL enforce match.
      regularTenantToken = tenantApp.jwt.sign({
        sub: 'user-1',
        role: 'tenant_user',
        panel: 'tenant',
        tenantId: 'tenant-regular',
        iat: Math.floor(Date.now() / 1000),
      });

      // Admin-panel token — requireTenantAccess MUST bypass for admin
      // panel since RBAC is handled by requireRole.
      adminToken = tenantApp.jwt.sign({
        sub: 'admin-1',
        role: 'super_admin',
        panel: 'admin',
        iat: Math.floor(Date.now() / 1000),
      });

      // Hand-crafted panel=tenant token with NO tenantId claim — fail
      // closed (CLIENT_ACCESS_DENIED). Without this guard the smuggle
      // attempt below would be allowed (request → tenant route → all
      // tenants reachable). The middleware enforces "tenant-panel
      // tokens must have a tenantId claim".
      panellessToken = tenantApp.jwt.sign({
        sub: 'forged-1',
        role: 'tenant_user',
        panel: 'tenant',
        // intentionally no tenantId
        iat: Math.floor(Date.now() / 1000),
      });
    });

    afterAll(async () => {
      await tenantApp.close();
    });

    it('REFUSES a tenant-panel JWT for tenant X to act on SYSTEM tenant', async () => {
      const res = await tenantApp.inject({
        method: 'POST',
        url: `/tenants/${SYSTEM_TENANT_ID}/domains`,
        headers: { Authorization: `Bearer ${regularTenantToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CLIENT_ACCESS_DENIED');
    });

    it('REFUSES a tenant-panel JWT for tenant X to act on tenant Y (general cross-tenant guard)', async () => {
      const res = await tenantApp.inject({
        method: 'POST',
        url: '/tenants/tenant-different/domains',
        headers: { Authorization: `Bearer ${regularTenantToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CLIENT_ACCESS_DENIED');
    });

    it('REFUSES a tenant-panel JWT with NO tenantId claim (forged token defense)', async () => {
      const res = await tenantApp.inject({
        method: 'POST',
        url: `/tenants/${SYSTEM_TENANT_ID}/domains`,
        headers: { Authorization: `Bearer ${panellessToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CLIENT_ACCESS_DENIED');
    });

    it('ALLOWS an admin-panel token to act on the SYSTEM tenant (the bypass is intentional for admins)', async () => {
      const res = await tenantApp.inject({
        method: 'POST',
        url: `/tenants/${SYSTEM_TENANT_ID}/domains`,
        headers: { Authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().tenantId).toBe(SYSTEM_TENANT_ID);
    });

    it('ALLOWS a tenant-panel JWT for tenant X to act on its OWN tenant (the happy path)', async () => {
      const res = await tenantApp.inject({
        method: 'POST',
        url: '/tenants/tenant-regular/domains',
        headers: { Authorization: `Bearer ${regularTenantToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
