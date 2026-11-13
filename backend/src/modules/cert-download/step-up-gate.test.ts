/**
 * The panel's certificate download hands out the domain's private key, and a
 * download token fetches the same key unattended. Both need a fresh step-up,
 * on the server; the token route itself (a token is its own credential) does
 * not, or an unattended renewal fetch could never work.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';

const REF = { domainId: 'dom-1', tenantId: '11111111-1111-4111-8111-111111111111', domainName: 'example.test', namespace: 'ns' };
const BUNDLE = { domainName: 'example.test', source: 'managed', pem: '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n' };

const buildCertBundle = vi.fn();
vi.mock('./bundle.js', () => ({
  buildCertBundle: (...a: unknown[]) => buildCertBundle(...a),
  probeCertAvailability: vi.fn(),
  resolveDomainById: vi.fn(async (_db: unknown, tenantId: string) => (tenantId === REF.tenantId ? REF : null)),
  resolveDomainByName: vi.fn(async () => REF),
}));
const createToken = vi.fn();
const verifyToken = vi.fn();
vi.mock('./token-service.js', () => ({
  createToken: (...a: unknown[]) => createToken(...a),
  verifyToken: (...a: unknown[]) => verifyToken(...a),
  touchToken: vi.fn(),
  listTokens: vi.fn(async () => []),
  revokeToken: vi.fn(),
}));
vi.mock('../k8s-provisioner/k8s-client.js', () => ({ createK8sClients: () => null }));
const assertFreshStepUp = vi.fn();
vi.mock('../auth/step-up-service.js', async (orig) => ({
  ...(await orig<typeof import('../auth/step-up-service.js')>()),
  assertFreshStepUp: (...a: unknown[]) => assertFreshStepUp(...a),
}));

const { certDownloadRoutes } = await import('./routes.js');

const audits: Record<string, unknown>[] = [];
const fakeDb = {
  insert: () => ({ values: (v: Record<string, unknown>) => { audits.push(v); return { catch: () => undefined }; } }),
};
const base = `/api/v1/tenants/${REF.tenantId}/domains/${REF.domainId}`;

describe('certificate download step-up', () => {
  let app: FastifyInstance;
  let tenantToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', fakeDb as never);
    await app.register(certDownloadRoutes, { prefix: '/api/v1' });
    await app.ready();
    tenantToken = app.jwt.sign({ sub: 'u1', role: 'tenant_admin', panel: 'tenant', tenantId: REF.tenantId, iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    assertFreshStepUp.mockReset().mockResolvedValue(undefined);
    buildCertBundle.mockReset().mockResolvedValue(BUNDLE);
    createToken.mockReset().mockResolvedValue({ id: 'tok-1', name: 'ci', token: 'secret-token' });
    verifyToken.mockReset();
  });

  const auth = () => ({ authorization: `Bearer ${tenantToken}` });
  const stepUpRequired = () => new ApiError('STEP_UP_REQUIRED', 'Confirm it is you', 403, { methods: ['password'] });

  it('downloads after a fresh step-up', async () => {
    const res = await app.inject({ method: 'GET', url: `${base}/ssl-cert/download`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('PRIVATE KEY');
    expect(assertFreshStepUp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sub: 'u1' }), 'cert_download');
  });

  it('refuses the download without one, and never builds the bundle', async () => {
    assertFreshStepUp.mockRejectedValue(stepUpRequired());
    const res = await app.inject({ method: 'GET', url: `${base}/ssl-cert/download`, headers: auth() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(buildCertBundle).not.toHaveBeenCalled();
  });

  it('refuses to mint a download token without one — it fetches the same key', async () => {
    assertFreshStepUp.mockRejectedValue(stepUpRequired());
    const res = await app.inject({ method: 'POST', url: `${base}/cert-tokens`, headers: auth(), payload: { name: 'ci', expiry: '1h' } });
    expect(res.statusCode).toBe(403);
    expect(createToken).not.toHaveBeenCalled();
  });

  it('mints a token after a fresh step-up', async () => {
    const res = await app.inject({ method: 'POST', url: `${base}/cert-tokens`, headers: auth(), payload: { name: 'ci', expiry: '1h' } });
    expect(res.statusCode).toBe(201);
    expect(assertFreshStepUp).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'cert_download');
  });

  it('answers another tenant\'s domain with 404 before any step-up check', async () => {
    const other = app.jwt.sign({ sub: 'u9', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/22222222-2222-4222-8222-222222222222/domains/${REF.domainId}/ssl-cert/download`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(res.statusCode).toBe(404);
    expect(assertFreshStepUp).not.toHaveBeenCalled();
  });

  // Operator decision: an API token needs no step-up here, and works as it
  // did before the gate (the gate itself lets it through — step-up-gate.test).
  it('lets an API token download and mint, like before the gate', async () => {
    const pat = app.jwt.sign({
      sub: 'a1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000),
      apiToken: { tokenId: 'pat-1', kind: 'pat', name: 'renewals', scopes: ['read', 'write'], via: 'api' },
    });
    audits.length = 0;
    const dl = await app.inject({ method: 'GET', url: `${base}/ssl-cert/download`, headers: { authorization: `Bearer ${pat}` } });
    expect(dl.statusCode).toBe(200);
    expect(audits[0]).toMatchObject({ changes: expect.objectContaining({ apiTokenId: 'pat-1', via: 'api' }) });
    const mint = await app.inject({
      method: 'POST', url: `${base}/cert-tokens`, headers: { authorization: `Bearer ${pat}` }, payload: { name: 'ci', expiry: '15m' },
    });
    expect(mint.statusCode).toBe(201);
  });

  it('works under "Login as tenant", and the audit row names the staff member', async () => {
    const imp = app.jwt.sign({
      sub: 'u1', role: 'tenant_admin', panel: 'tenant', tenantId: REF.tenantId, impersonatedBy: 'staff-1',
      sid: 'imp:abc', iat: Math.floor(Date.now() / 1000),
    });
    audits.length = 0;
    const res = await app.inject({ method: 'GET', url: `${base}/ssl-cert/download`, headers: { authorization: `Bearer ${imp}` } });
    expect(res.statusCode).toBe(200);
    expect(assertFreshStepUp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ impersonatedBy: 'staff-1' }), 'cert_download');
    expect(audits[0]).toMatchObject({ changes: expect.objectContaining({ impersonatedBy: 'staff-1' }) });
  });

  it('refuses a link lifetime past 24 hours', async () => {
    const res = await app.inject({ method: 'POST', url: `${base}/cert-tokens`, headers: auth(), payload: { name: 'ci', expiry: '90d' } });
    expect(res.statusCode).toBe(400);
    expect(createToken).not.toHaveBeenCalled();
  });

  it('leaves the token route alone: the token is the credential', async () => {
    verifyToken.mockResolvedValue({ tokenId: 'tok-1', tenantId: REF.tenantId, domainId: REF.domainId, name: 'ci' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/certs/example.test/download', headers: { authorization: 'Bearer cert-token' } });
    expect(res.statusCode).toBe(200);
    expect(assertFreshStepUp).not.toHaveBeenCalled();
  });
});
