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

// Captured so the tests can assert nothing is dispatched. There is no
// force-override path any more; the advisory deliberately notifies nobody.
const notifySpy = vi.fn().mockResolvedValue(undefined);
const audited: unknown[] = [];
vi.mock('../notifications/events.js', () => ({
  notifyAdminOperationalEvent: (...a: unknown[]) => notifySpy(...a),
}));

// `details` is merged, not replaced — a test overriding one field must still
// get a complete shape, or the route reads undefined and 500s.
const gateResult = ({ details, ...rest }: Record<string, unknown> = {}) => ({
  withinBudget: true,
  reason: null,
  ...rest,
  details: {
    currentSumCpu: 0, currentSumMemoryGi: 0,
    projectedSumCpu: 4, projectedSumMemoryGi: 4,
    headroomCpu: 100, headroomMemoryGi: 100,
    overByCpu: 0, overByMemoryGi: 0,
    worsensCpu: false, worsensMemory: false, worsensFailover: false,
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
    // Stub db.insert(auditLogs).values(...) — the route emits an audit entry
    // on every real change, plus `…over_headroom` when the advisory fires. The stub just resolves.
    app.decorate('db', {
      insert: () => ({ values: (v: unknown) => { audited.push(v); return Promise.resolve(); } }),
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
    audited.length = 0;
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

  // ─── The headroom advisory ───────────────────────────────────────────────
  //
  // This endpoint used to 409 an over-budget quota. It does not any more:
  // oversubscription is an accepted position here, and the operator asked for
  // visibility, not a gate. What must survive is the MEASUREMENT — silently
  // dropping the verdict would be the original bug (a guard that says
  // nothing) wearing different clothes.

  const overBudget = () => mockGate.mockResolvedValue(gateResult({
    withinBudget: false,
    reason: 'This quota sells more than the server has: CPU over by 4.10 cores.',
    details: { overByCpu: 4.1, worsensCpu: true, isSingleServer: true, headroomClamped: true },
  }));
  const auditKinds = () => audited.map((a) => (a as { actionType: string }).actionType);

  it('ACCEPTS an over-budget quota instead of refusing it', async () => {
    overBudget();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1/resource-quota',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { cpu_cores_limit: 99 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns the verdict with the write, so an API caller sees it', async () => {
    overBudget();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1/resource-quota',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { cpu_cores_limit: 99 },
    });
    expect(res.json().data.headroomAdvisory).toContain('sells more than the server has');
  });

  it('records the breach in the audit trail', async () => {
    overBudget();
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1/resource-quota',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { cpu_cores_limit: 99 },
    });
    expect(auditKinds()).toContain('resource_quota.update.over_headroom');
  });

  /**
   * ★ The anti-storm property. This cluster is PERMANENTLY past its budget, so
   * a notification per edit would fan one standing condition out as an endless
   * stream of alarms. The condition is reported once, deduped per node, by the
   * CPU-reservation finding instead.
   */
  it('does not notify anyone — a standing condition is not a per-edit alarm', async () => {
    overBudget();
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1/resource-quota',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { cpu_cores_limit: 99 },
    });
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('says nothing when the quota fits', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1/resource-quota',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { cpu_cores_limit: 1 },
    });
    expect(res.json().data.headroomAdvisory).toBeNull();
    expect(auditKinds()).not.toContain('resource_quota.update.over_headroom');
  });

  // Scripts written against the refusing version pass ?force=true. It must not
  // become an error now that there is nothing to force.
  it('still accepts a legacy ?force=true without complaint', async () => {
    overBudget();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenants/c1/resource-quota?force=true',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { cpu_cores_limit: 99 },
    });
    expect(res.statusCode).toBe(200);
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
