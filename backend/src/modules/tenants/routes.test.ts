import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockTenant = {
  id: 'c1',
  name: 'Acme Corp',
  primaryEmail: 'admin@acme.com',
  status: 'active',
  createdAt: new Date('2026-01-01').toISOString(),
};

// Mock the service module before importing routes
vi.mock('./service.js', () => ({
  createTenant: vi.fn().mockResolvedValue({ ...mockTenant, id: 'new-id' }),
  getTenantById: vi.fn().mockResolvedValue(mockTenant),
  listTenants: vi.fn().mockResolvedValue({
    data: [mockTenant],
    pagination: { cursor: null, has_more: false, page_size: 1, total_count: 1 },
  }),
  updateTenant: vi.fn().mockResolvedValue({ ...mockTenant, name: 'Updated' }),
  // deleteTenant now returns { transitionId } so the route can wrap it
  // in the standard success envelope (the UI uses the id to open the
  // progress modal without polling-by-since races).
  deleteTenant: vi.fn().mockResolvedValue({ transitionId: 'tx-test-1' }),
}));

// Mock the sub-users-service so the routes layer can be tested
// without a live database. The tests here are purely about
// role-gating and request wiring; deeper behavior (plan limits,
// last-admin guard, etc.) is covered in sub-users-service.test.ts.
const listSubUsersMock = vi.fn().mockResolvedValue([
  {
    id: 'u1',
    email: 'alice@c1.com',
    fullName: 'Alice',
    roleName: 'tenant_admin',
    status: 'active',
    createdAt: new Date('2026-01-01'),
    lastLoginAt: null,
  },
]);
const createSubUserMock = vi.fn().mockImplementation(
  (_db: unknown, _clientId: string, input: { email: string; full_name: string; role_name?: string }) => {
    return Promise.resolve({
      id: 'u-new',
      email: input.email,
      fullName: input.full_name,
      // Reflect the role from the payload so tests can assert the
      // route wires the parsed body through to the service.
      roleName: input.role_name ?? 'tenant_user',
      status: 'active',
      createdAt: new Date('2026-01-02'),
    });
  },
);
const deleteSubUserMock = vi.fn().mockResolvedValue(undefined);
const resetSubUserPasswordMock = vi.fn().mockResolvedValue(undefined);
const updateSubUserMock = vi.fn().mockImplementation(
  (_db: unknown, _clientId: string, userId: string, payload: { fullName?: string; roleName?: string; status?: string }) => {
    return Promise.resolve({
      id: userId,
      email: 'alice@c1.com',
      fullName: payload.fullName ?? 'Alice',
      roleName: payload.roleName ?? 'tenant_user',
      status: payload.status ?? 'active',
      createdAt: new Date('2026-01-01'),
      lastLoginAt: null,
    });
  },
);

vi.mock('./sub-users-service.js', () => ({
  listSubUsers: (...args: unknown[]) => listSubUsersMock(...args),
  createSubUser: (...args: unknown[]) => createSubUserMock(...args),
  updateSubUser: (...args: unknown[]) => updateSubUserMock(...args),
  resetSubUserPassword: (...args: unknown[]) => resetSubUserPasswordMock(...args),
  deleteSubUser: (...args: unknown[]) => deleteSubUserMock(...args),
  makeDrizzleSubUsersDb: vi.fn().mockReturnValue({}),
  getEffectiveMaxSubUsers: vi.fn().mockResolvedValue(10),
}));

// Import routes AFTER mocking
const { tenantRoutes } = await import('./routes.js');

describe('tenant routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;
  let supportToken: string;
  let tenantAdminToken: string;
  let tenantAdminNoTenantIdToken: string;
  let tenantUserToken: string;
  let otherTenantAdminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    // Decorate with a stub db. Phase 3: routes that disable users or
    // reset passwords also revoke refresh tokens via
    // revokeAllUserRefreshTokens — that hits db.update().set().where().
    // Stub the chain so the route can complete; the service-layer
    // mocks supply the real assertion data.
    const noopUpdate = {
      set: () => ({ where: async () => undefined }),
    };
    app.decorate('db', { update: () => noopUpdate });
    await app.register(tenantRoutes, { prefix: '/api/v1' });
    await app.ready();

    const iat = Math.floor(Date.now() / 1000);
    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat });
    tenantAdminToken = app.jwt.sign({
      sub: 'ca-1', role: 'tenant_admin', panel: 'tenant', tenantId: 'c1', iat,
    });
    tenantAdminNoTenantIdToken = app.jwt.sign({
      // Phase 1 hardening: tenant-panel tokens without a tenantId
      // claim must be rejected by requireTenantAccess(). The bug
      // previously allowed them through whenever the URL-param
      // tenantId happened to be present.
      sub: 'ca-broken', role: 'tenant_admin', panel: 'tenant', iat,
    });
    tenantUserToken = app.jwt.sign({
      sub: 'cu-1', role: 'tenant_user', panel: 'tenant', tenantId: 'c1', iat,
    });
    otherTenantAdminToken = app.jwt.sign({
      sub: 'ca-2', role: 'tenant_admin', panel: 'tenant', tenantId: 'c2', iat,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    listSubUsersMock.mockClear();
    createSubUserMock.mockClear();
    updateSubUserMock.mockClear();
    resetSubUserPasswordMock.mockClear();
    deleteSubUserMock.mockClear();
  });

  it('GET /api/v1/tenants should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tenants' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/v1/tenants should require admin role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /api/v1/tenants should return paginated results for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.pagination).toBeDefined();
  });

  it('GET /api/v1/tenants/:id should return tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/c1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/v1/tenants should reject invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(['MISSING_REQUIRED_FIELD', 'VALIDATION_ERROR']).toContain(res.json().error.code);
  });

  it('POST /api/v1/tenants should create tenant with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'New Corp',
        primary_email: 'admin@newcorp.com',
        plan_id: '550e8400-e29b-41d4-a716-446655440000',
        region_id: '550e8400-e29b-41d4-a716-446655440001',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('PATCH /api/v1/tenants/:id should reject invalid field values', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'invalid-status' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FIELD_VALUE');
  });

  it('PATCH /api/v1/tenants/:id should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Updated Corp' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE /api/v1/tenants/:id returns 200 with a transitionId', async () => {
    // The route used to 204 with an empty body; it now returns
    // { data: { transitionId } } so the admin panel can open the
    // progress modal by ID without a polling-by-since race.
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/tenants/c1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.transitionId).toBe('tx-test-1');
  });

  // ─── Sub-User Routes (Phase 1 regression coverage) ──────────────────────
  //
  // The previous version of tenants/routes.ts installed
  // `requireRole('super_admin','admin')` as a plugin-wide hook which
  // rejected tenant_admin / tenant_user tokens before the permissive
  // per-route hooks could run, producing 403 on GET /users. These
  // tests lock in the per-route hook structure and the tenant_user
  // read permission added alongside.

  describe('GET /api/v1/tenants/:tenantId/users', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/tenants/c1/users' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects read_only admin with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${readOnlyToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows super_admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);
      expect(listSubUsersMock).toHaveBeenCalledWith(expect.anything(), 'c1');
    });

    it('allows support role', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${supportToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows tenant_admin for their own tenant (regression: the plugin-wide hook bug)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows tenant_user read access for their own tenant', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantUserToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects tenant_admin from another tenant (cross-tenant)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${otherTenantAdminToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CLIENT_ACCESS_DENIED');
    });

    it('rejects a tenant-panel token with no tenantId claim (Phase 1 hardening)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantAdminNoTenantIdToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CLIENT_ACCESS_DENIED');
    });
  });

  describe('POST /api/v1/tenants/:tenantId/users', () => {
    const validBody = { email: 'new@c1.com', full_name: 'New User', password: 'password123' };

    it('allows tenant_admin to create a sub-user in their own tenant', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(201);
      expect(createSubUserMock).toHaveBeenCalled();
    });

    it('rejects tenant_user (read-only cannot create)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantUserToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
      expect(createSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects support role (read-only staff cannot create)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${supportToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects tenant_admin from another tenant', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${otherTenantAdminToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a malformed email (Zod validation)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: { email: 'notanemail', full_name: 'Bad', password: 'password123' },
      });
      expect(res.statusCode).toBe(400);
      expect(createSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects a password shorter than 8 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: { email: 'ok@c1.com', full_name: 'OK', password: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect(createSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects a missing full_name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: { email: 'ok@c1.com', full_name: '', password: 'password123' },
      });
      expect(res.statusCode).toBe(400);
      expect(createSubUserMock).not.toHaveBeenCalled();
    });

    it('accepts role_name=tenant_admin in the body (Phase 2)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: {
          email: 'promoted@c1.com',
          full_name: 'Promoted',
          password: 'password123',
          role_name: 'tenant_admin',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(createSubUserMock).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        expect.objectContaining({ role_name: 'tenant_admin' }),
        expect.anything(),
      );
      // Assert the roleName is reflected in the response body — this
      // catches bugs where the route forgets to pass role_name through.
      expect(res.json().data.roleName).toBe('tenant_admin');
    });

    it('rejects tenant_user attempting to create a tenant_admin (authz before body parse)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantUserToken}` },
        payload: {
          email: 'escalate@c1.com',
          full_name: 'Escalate',
          password: 'password123',
          role_name: 'tenant_admin',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(createSubUserMock).not.toHaveBeenCalled();
    });

    it('accepts role_name=tenant_user in the body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: {
          email: 'member@c1.com',
          full_name: 'Member',
          password: 'password123',
          role_name: 'tenant_user',
        },
      });
      expect(res.statusCode).toBe(201);
    });

    it('rejects role_name outside the enum', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: {
          email: 'bad@c1.com',
          full_name: 'Bad',
          password: 'password123',
          role_name: 'super_admin',
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/v1/tenants/:tenantId/users/:userId (Phase 3)', () => {
    it('allows tenant_admin to rename a sub-user', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/tenants/c1/users/u1',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: { full_name: 'Renamed' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.fullName).toBe('Renamed');
      expect(updateSubUserMock).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        'u1',
        expect.objectContaining({ fullName: 'Renamed' }),
      );
    });

    it('allows status changes (disable)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/tenants/c1/users/u1',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: { status: 'disabled' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('disabled');
    });

    it('allows role changes', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/tenants/c1/users/u1',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: { role_name: 'tenant_admin' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.roleName).toBe('tenant_admin');
    });

    it('rejects an empty patch body', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/tenants/c1/users/u1',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(updateSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects invalid status values', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/tenants/c1/users/u1',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: { status: 'pending' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects tenant_user (read-only cannot edit)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/tenants/c1/users/u1',
        headers: { authorization: `Bearer ${tenantUserToken}` },
        payload: { full_name: 'Evil' },
      });
      expect(res.statusCode).toBe(403);
      expect(updateSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant edits', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/tenants/c1/users/u1',
        headers: { authorization: `Bearer ${otherTenantAdminToken}` },
        payload: { full_name: 'Hack' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('requires auth', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/tenants/c1/users/u1',
        payload: { full_name: 'Anon' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/tenants/:tenantId/users/:userId/reset-password (Phase 4)', () => {
    const validBody = { new_password: 'brand-new-pw-123' };

    it('allows tenant_admin to reset a sub-user password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users/u1/reset-password',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(204);
      expect(resetSubUserPasswordMock).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        'u1',
        'brand-new-pw-123',
      );
    });

    it('rejects passwords shorter than 8 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users/u1/reset-password',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: { new_password: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect(resetSubUserPasswordMock).not.toHaveBeenCalled();
    });

    it('rejects a missing new_password field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users/u1/reset-password',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects tenant_user (read-only cannot reset passwords)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users/u1/reset-password',
        headers: { authorization: `Bearer ${tenantUserToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
      expect(resetSubUserPasswordMock).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant password resets', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users/u1/reset-password',
        headers: { authorization: `Bearer ${otherTenantAdminToken}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
    });

    it('requires auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/users/u1/reset-password',
        payload: validBody,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('DELETE /api/v1/tenants/:tenantId/users/:userId', () => {
    it('allows tenant_admin to delete a sub-user in their own tenant', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/tenants/c1/users/u1',
        headers: { authorization: `Bearer ${tenantAdminToken}` },
      });
      expect(res.statusCode).toBe(204);
      expect(deleteSubUserMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'u1');
    });

    it('rejects tenant_user', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/tenants/c1/users/u1',
        headers: { authorization: `Bearer ${tenantUserToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(deleteSubUserMock).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/tenants/c1/users/u1',
        headers: { authorization: `Bearer ${otherTenantAdminToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('requires auth', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/v1/tenants/c1/users/u1' });
      expect(res.statusCode).toBe(401);
    });
  });
});
