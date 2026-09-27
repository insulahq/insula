import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockPreview = {
  allocatableMillis: 7500,
  reservedMillis: 7197,
  usedMillis: 883,
  reclaimableMillis: 4115,
  tenants: [],
  needsReviewCount: 0,
};

vi.mock('./preview.js', () => ({
  buildCpuMigrationPreview: vi.fn().mockResolvedValue(mockPreview),
}));

vi.mock('../k8s-provisioner/k8s-client.js', () => ({
  createK8sClients: vi.fn().mockReturnValue({}),
}));

const { cpuMigrationRoutes } = await import('./routes.js');

describe('cpu-migration routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let supportToken: string;
  let tenantToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    app.decorate('config', { KUBECONFIG_PATH: undefined });
    await app.register(cpuMigrationRoutes, { prefix: '/api/v1' });
    await app.ready();

    const now = Math.floor(Date.now() / 1000);
    adminToken = app.jwt.sign({ sub: 'a-1', role: 'super_admin', panel: 'admin', iat: now });
    supportToken = app.jwt.sign({ sub: 's-1', role: 'support', panel: 'admin', iat: now });
    tenantToken = app.jwt.sign({ sub: 't-1', role: 'tenant_admin', panel: 'tenant', iat: now });
  });

  afterAll(async () => { await app.close(); });

  it('returns the preview to an admin, in the standard envelope', async () => {
    const r = await app.inject({
      method: 'GET', url: '/api/v1/admin/cpu-migration/preview',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual(mockPreview);
  });

  // This report names every tenant and their capacity. It is an admin view,
  // and the role gate is the only thing standing between it and a support or
  // tenant session.
  it('refuses a support role', async () => {
    const r = await app.inject({
      method: 'GET', url: '/api/v1/admin/cpu-migration/preview',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it('refuses a tenant session', async () => {
    const r = await app.inject({
      method: 'GET', url: '/api/v1/admin/cpu-migration/preview',
      headers: { authorization: `Bearer ${tenantToken}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it('refuses an unauthenticated request', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/admin/cpu-migration/preview' });
    expect(r.statusCode).toBe(401);
  });

  // R1 is a read-only release. If a write path ever appears in this module it
  // should be a deliberate decision with its own review, not something that
  // arrives because a route file grew.
  it('exposes no mutating verb on the preview path', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
      const r = await app.inject({
        method, url: '/api/v1/admin/cpu-migration/preview',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(r.statusCode).toBe(404);
    }
  });
});
