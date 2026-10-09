/**
 * The upgrade routes through Fastify's real request validation. A field the
 * route's JSON body schema does not declare is stripped BEFORE the handler's Zod
 * parse sees it (additionalProperties:false + removeAdditional) — which is how
 * "Upgrade without <node>" reached the API and silently became "upgrade every
 * node", refusing on the down node's pre-flight (found on the lab staging).
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const collectPreflightFacts = vi.fn();
const startRunWithTask = vi.fn();
vi.mock('../k8s-provisioner/k8s-client.js', () => ({ createK8sClients: () => ({}) }));
vi.mock('./collect-preflight.js', () => ({ collectPreflightFacts: (...a: unknown[]) => collectPreflightFacts(...a) }));
vi.mock('./orchestrate.js', () => ({
  dbSettings: () => ({ get: async () => '2026.10.7-rc.3', set: async () => {} }),
  runUpgrade: async () => ({
    decision: { action: 'upgrade', target: '2026.10.7-rc.4', reason: 'manual', proceed: true },
    environment: 'production', gitRepository: 'hosting-platform-production', applied: false, summary: 'DRY-RUN',
  }),
}));
vi.mock('./run/real.js', () => ({
  startRunWithTask: (...a: unknown[]) => startRunWithTask(...a),
  abortActiveRun: vi.fn(), cancelPreparingRun: vi.fn(),
}));

const { platformUpgradeRoutes } = await import('./routes.js');

const healthyFacts = (excluded: string[]) => ({
  environment: 'production', cnpgReady: true, cnpgDetail: 'ok', longhornAtRiskVolumes: 0, inFlightTransitions: 0,
  maxDiskUsedPct: 20, nodesWithDiskPressure: 0, freshestBackupAgeHours: 1, fluxSuspended: [],
  nodes: [{ name: 'sv1', ready: true }, { name: 'w1', ready: false }], excludedNodes: excluded, upgradeRunning: false,
});

describe('platform-upgrade routes (Fastify validation)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    app.decorate('config', {});
    await app.register(platformUpgradeRoutes, { prefix: '/api/v1' });
    await app.ready();
    token = app.jwt.sign({ sub: '00000000-0000-4000-8000-000000000001', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    collectPreflightFacts.mockReset().mockImplementation(async (_db: unknown, _k: unknown, _n: unknown, ex: string[] = []) => healthyFacts(ex));
    startRunWithTask.mockReset().mockResolvedValue({ id: 'run-1', status: 'running', message: null });
  });

  it('apply carries excludeNodes to the pre-flight and the run', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/admin/platform/upgrade',
      headers: { authorization: `Bearer ${token}` },
      payload: { version: '2026.10.7-rc.4', apply: true, excludeNodes: ['w1'] },
    });
    expect(res.statusCode).toBe(200);
    expect(collectPreflightFacts.mock.calls[0]?.[3]).toEqual(['w1']);
    expect(startRunWithTask.mock.calls[0]?.[2]).toMatchObject({ toVersion: '2026.10.7-rc.4', excludedNodes: ['w1'] });
    expect(res.json().data).toMatchObject({ applied: true, runId: 'run-1' });
  });

  it('without the exclusion the down node blocks the apply (409, naming the gate)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/admin/platform/upgrade',
      headers: { authorization: `Bearer ${token}` },
      payload: { version: '2026.10.7-rc.4', apply: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/Every node can take part: w1 is not Ready/);
    expect(startRunWithTask).not.toHaveBeenCalled();
  });

  it('pre-flight ?exclude= reaches the gate evaluation', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/platform/upgrade/preflight?exclude=w1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(collectPreflightFacts.mock.calls[0]?.[3]).toEqual(['w1']);
    expect(res.json().data.ok).toBe(true);
  });
});
