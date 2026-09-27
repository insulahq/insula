import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockQuota = {
  id: 'q-1',
  tenantId: 'c1',
  cpuCoresLimit: '2.00',
  memoryGbLimit: 4,
  storageGbLimit: 50,
  bandwidthGbLimit: 100,
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  getResourceQuota: vi.fn().mockResolvedValue(mockQuota),
  updateResourceQuota: vi.fn().mockResolvedValue({ ...mockQuota, cpuCoresLimit: '4.00' }),
  getTenantResourceAvailability: vi.fn(),
}));

// Mock the headroom gate so existing happy-path PATCH tests don't need
// a live k8s — gate-specific tests live in headroom-gate.test.ts.
const mockGate = vi.fn();
vi.mock('./headroom-gate.js', () => ({
  validateQuotaFitsHeadroom: (...a: unknown[]) => mockGate(...a),
}));

// The force-override path fans a notification out to every admin. Capture it
// rather than letting the real dispatcher run.
const notifySpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../notifications/events.js', () => ({
  notifyAdminOperationalEvent: (...a: unknown[]) => notifySpy(...a),
}));

// `details` is merged, not replaced — a test overriding one field must still
// get a complete shape, or the route reads undefined and 500s.
const gateResult = ({ details, ...rest }: Record<string, unknown> = {}) => ({
  allowed: true,
  reason: null,
  ...rest,
  details: {
    currentSumCpu: 0, currentSumMemoryGi: 0,
    projectedSumCpu: 4, projectedSumMemoryGi: 4,
    headroomCpu: 100, headroomMemoryGi: 100,
    overByCpu: 0, overByMemoryGi: 0,
    refusedByCpu: false, refusedByMemory: false, refusedByFailover: false,
    isSingleServer: false, headroomClamped: false,
    ...(details as Record<string, unknown> ?? {}),
  },
});

// createK8sClients is invoked when the gate applies — return an empty
// stub since the gate is mocked anyway.
vi.mock('../k8s-provisioner/k8s-client.js', () => ({
  createK8sClients: vi.fn().mockReturnValue({}),
}));

const { resourceQuotaRoutes } = await import('./routes.js');

describe('resource-quota routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let supportToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    // Stub db.insert(auditLogs).values(...) — the route emits audit
    // entries on success/refuse/override. The stub just resolves.
    app.decorate('db', {
      insert: () => ({ values: () => Promise.resolve() }),
      // The force-override path reads the admin list to fan a notification out.
      select: () => ({ from: () => ({ where: () => Promise.resolve([{ id: 'admin-1' }]) }) }),
    });
    // KUBECONFIG_PATH is read from app.config; nothing else needs it
    // since createK8sClients is mocked.
    app.decorate('config', { KUBECONFIG_PATH: undefined });
    await app.register(resourceQuotaRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  beforeEach(() => {
    mockGate.mockResolvedValue(gateResult());
    notifySpy.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  it('GET resource-quota should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tenants/c1/resource-quota' });
    expect(res.statusCode).toBe(401);
  });

  // ─── GET ─────────────────────────────────────────────────────────────────

  it('GET resource-quota should return quota for any authenticated user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/c1/resource-quota',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // ─── PATCH ───────────────────────────────────────────────────────────────

  it('PATCH resource-quota should reject non-admin role', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1/resource-quota',
      headers: { authorization: `Bearer ${supportToken}` },
      payload: { cpu_cores_limit: 4 },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── The headroom gate ───────────────────────────────────────────────────

  it('refuses an over-budget patch with 409 CLUSTER_HEADROOM_EXCEEDED', async () => {
    mockGate.mockResolvedValue(gateResult({
      allowed: false,
      reason: 'Granting this quota would sell more than the server has: CPU over by 2.00 cores.',
      details: { overByCpu: 2, refusedByCpu: true, isSingleServer: true, headroomClamped: true },
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1/resource-quota',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { cpu_cores_limit: 99 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CLUSTER_HEADROOM_EXCEEDED');
  });

  /**
   * ★ The override alert must name the dimension that was actually refused.
   * overByCpu measures the CLUSTER total and stays positive for a dimension
   * being REDUCED — captioning from it announced "CPU +3.30 cores overridden"
   * to every admin for a patch that lowered that tenant's CPU.
   */
  it('names only the refused dimension in the force-override alert', async () => {
    mockGate.mockResolvedValue(gateResult({
      allowed: false,
      reason: 'memory over by 4.00 GiB',
      details: {
        // CPU is over cluster-wide but this patch LOWERS it — not the cause.
        overByCpu: 3.3, refusedByCpu: false,
        overByMemoryGi: 4, refusedByMemory: true,
        isSingleServer: false,
      },
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1/resource-quota?force=true',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { cpu_cores_limit: 1, memory_gb_limit: 8 },
    });
    expect(res.statusCode).toBe(200);
    expect(notifySpy).toHaveBeenCalled();
    const detail = String((notifySpy.mock.calls[0][2] as { detail: string }).detail);
    expect(detail).toContain('memory +4.00 GiB');
    expect(detail).not.toContain('CPU +');
  });

  // The consequence stated must be true of THIS cluster: there is no
  // single-server loss to survive on a single-server cluster.
  it('states a consequence that matches the cluster shape', async () => {
    mockGate.mockResolvedValue(gateResult({
      allowed: false,
      reason: 'CPU over by 2.00 cores',
      details: { overByCpu: 2, refusedByCpu: true, isSingleServer: true, headroomClamped: true },
    }));
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1/resource-quota?force=true',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { cpu_cores_limit: 99 },
    });
    const action = String((notifySpy.mock.calls[0][2] as { recommendedAction: string }).recommendedAction);
    expect(action).toContain('oversubscribed');
    expect(action).not.toContain('survive single-server loss');
  });

  it('PATCH resource-quota should update for admin', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1/resource-quota',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { cpu_cores_limit: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });
});
