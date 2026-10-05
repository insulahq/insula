/**
 * Route wiring for the Malicious Traffic Detection on/off.
 *
 * The ORDER is the contract: the choice is saved to platform_settings before
 * it is applied to the agent, so an apply failure is re-applied at the next
 * startup instead of being forgotten — and the operator is told it is saved
 * but not applied, rather than "failed" (which would read as "nothing
 * changed" and invite a second toggle).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../middleware/auth.js', () => ({
  authenticate: async (req: { user?: unknown }) => { req.user = { sub: 'admin-1', role: 'super_admin' }; },
  requireRole: () => async () => {},
  requirePanel: () => async () => {},
}));

const setTrafficDetectionEnabled = vi.fn();
const listScenarios = vi.fn();
const setScenarioSimulation = vi.fn();
class FakeConflict extends Error {
  constructor(readonly attempts: number) { super(`lost ${attempts} compare-and-swap attempts`); }
}
vi.mock('./crowdsec-scenarios.js', () => ({
  setTrafficDetectionEnabled: (...a: unknown[]) => setTrafficDetectionEnabled(...a),
  listScenarios: (...a: unknown[]) => listScenarios(...a),
  setScenarioSimulation: (...a: unknown[]) => setScenarioSimulation(...a),
  SimulationConfigConflictError: FakeConflict,
}));

const readTrafficDetectionEnabled = vi.fn();
const writeTrafficDetectionEnabled = vi.fn();
vi.mock('./traffic-detection-setting.js', () => ({
  readTrafficDetectionEnabled: (...a: unknown[]) => readTrafficDetectionEnabled(...a),
  writeTrafficDetectionEnabled: (...a: unknown[]) => writeTrafficDetectionEnabled(...a),
}));

const { buildSecurityHardeningRoutes } = await import('./routes.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

const db = { marker: 'db' };
let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  readTrafficDetectionEnabled.mockResolvedValue(null);
  writeTrafficDetectionEnabled.mockResolvedValue(undefined);
  app = Fastify();
  app.decorate('config', {} as never);
  app.setErrorHandler(errorHandler);
  await app.register(buildSecurityHardeningRoutes({ db: db as never }), { prefix: '/api/v1' });
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe('PUT /admin/security/crowdsec/traffic-detection', () => {
  it('saves the choice, THEN applies it, and returns the applied state', async () => {
    setTrafficDetectionEnabled.mockResolvedValue({
      enabled: false, alertOnly: ['crowdsecurity/http-crawl-non_statics'], rolledPods: 1, rollError: null,
    });
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/admin/security/crowdsec/traffic-detection', payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      enabled: false, alertOnly: ['crowdsecurity/http-crawl-non_statics'], rolledPods: 1, rollError: null,
    });
    expect(writeTrafficDetectionEnabled).toHaveBeenCalledWith(db, false);
    expect(writeTrafficDetectionEnabled.mock.invocationCallOrder[0])
      .toBeLessThan(setTrafficDetectionEnabled.mock.invocationCallOrder[0]);
  });

  it('applies what is SAVED at write time, falling back to the request only if the row is missing', async () => {
    setTrafficDetectionEnabled.mockResolvedValue({ enabled: true, alertOnly: [], rolledPods: 0, rollError: null });
    await app.inject({
      method: 'PUT', url: '/api/v1/admin/security/crowdsec/traffic-detection', payload: { enabled: false },
    });
    const readSaved = setTrafficDetectionEnabled.mock.calls[0][1] as () => Promise<boolean>;
    expect(setTrafficDetectionEnabled.mock.calls[0][0]).toBeUndefined();

    readTrafficDetectionEnabled.mockResolvedValueOnce(true); // a later toggle saved "enabled"
    expect(await readSaved()).toBe(true);
    readTrafficDetectionEnabled.mockResolvedValueOnce(null);
    expect(await readSaved()).toBe(false);
  });

  it('answers 409 with an operator error when every compare-and-swap attempt lost', async () => {
    setTrafficDetectionEnabled.mockRejectedValue(new FakeConflict(5));
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/admin/security/crowdsec/traffic-detection', payload: { enabled: false },
    });
    expect(res.statusCode).toBe(409);
    const op = res.json().error.details.operatorError;
    expect(op.code).toBe('CROWDSEC_SIMULATION_CONFLICT');
    expect(op.title).toMatch(/Saved, but not applied yet/);
    expect(op.retryable).toBe(true);
  });

  it('rejects a body without a boolean and saves nothing', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/admin/security/crowdsec/traffic-detection', payload: { enabled: 'no' },
    });
    expect(res.statusCode).toBe(400);
    expect(writeTrafficDetectionEnabled).not.toHaveBeenCalled();
    expect(setTrafficDetectionEnabled).not.toHaveBeenCalled();
  });

  it('reports "saved, not applied" with an operator error when the agent config cannot be written', async () => {
    setTrafficDetectionEnabled.mockRejectedValue(new Error('configmaps is forbidden'));
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/admin/security/crowdsec/traffic-detection', payload: { enabled: false },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error.code).toBe('CROWDSEC_TRAFFIC_DETECTION_FAILED');
    expect(body.error.details.operatorError.title).toMatch(/Saved, but not applied/);
    expect(body.error.details.operatorError.detail).toMatch(/forbidden/);
    // The choice IS saved — the startup reconcile re-applies it.
    expect(writeTrafficDetectionEnabled).toHaveBeenCalledWith(db, false);
  });
});

describe('scenario routes pass the saved choice through', () => {
  it('GET lists with the saved choice', async () => {
    readTrafficDetectionEnabled.mockResolvedValue(false);
    listScenarios.mockResolvedValue({
      scenarios: [], globalSimulation: true, detectionEnabled: false, logSources: [], error: null,
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/security/crowdsec/scenarios' });
    expect(res.statusCode).toBe(200);
    expect(listScenarios).toHaveBeenCalledWith(undefined, false);
    expect(res.json().data.detectionEnabled).toBe(false);
  });

  it('GET still answers when the setting cannot be read — as "never saved"', async () => {
    readTrafficDetectionEnabled.mockRejectedValue(new Error('db down'));
    listScenarios.mockResolvedValue({
      scenarios: [], globalSimulation: false, detectionEnabled: true, logSources: [], error: null,
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/security/crowdsec/scenarios' });
    expect(res.statusCode).toBe(200);
    expect(listScenarios).toHaveBeenCalledWith(undefined, null);
  });

  it('PATCH (one scenario) passes the saved choice for the create-if-absent path', async () => {
    readTrafficDetectionEnabled.mockResolvedValue(false);
    setScenarioSimulation.mockResolvedValue({ simulated: [], rolledPods: 0, rollError: null });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/security/crowdsec/scenarios',
      payload: { name: 'crowdsecurity/http-probing', simulated: true },
    });
    expect(res.statusCode).toBe(200);
    const [kube, name, simulated, readSaved] = setScenarioSimulation.mock.calls[0] as [unknown, string, boolean, () => Promise<boolean | null>];
    expect([kube, name, simulated]).toEqual([undefined, 'crowdsecurity/http-probing', true]);
    expect(await readSaved()).toBe(false);
  });

  it('PATCH answers 409 with an operator error when every compare-and-swap attempt lost', async () => {
    setScenarioSimulation.mockRejectedValue(new FakeConflict(5));
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/security/crowdsec/scenarios',
      payload: { name: 'crowdsecurity/http-probing', simulated: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.operatorError).toMatchObject({
      code: 'CROWDSEC_SIMULATION_CONFLICT', title: 'Scenario not changed', retryable: true,
    });
  });
});
