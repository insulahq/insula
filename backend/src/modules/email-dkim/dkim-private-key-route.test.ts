/**
 * GET …/dkim/private-key — the domain's signing key, for signing elsewhere.
 *
 * What must hold: only the domain's own tenant admin (or staff) gets it, only
 * after a fresh step-up, never cached, always audited — and the audit row and
 * every refusal stay free of key material.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { generateKeyPairSync } from 'node:crypto';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SPKI = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const dkimSignatureGet = vi.fn();
vi.mock('../stalwart-jmap/client.js', () => ({ dkimSignatureGet: (...a: unknown[]) => dkimSignatureGet(...a) }));
vi.mock('./signatures.js', async (orig) => ({
  ...(await orig<typeof import('./signatures.js')>()),
  resolveDkimAccountId: vi.fn().mockResolvedValue('acct'),
}));
vi.mock('./keys.js', async (orig) => ({
  ...(await orig<typeof import('./keys.js')>()),
  readPublishedDkimRecords: vi.fn().mockResolvedValue([{ name: 'dkim-1._domainkey.example.test', value: 'v=DKIM1; p=A', ttl: 3600 }]),
}));
const readKept = vi.fn();
vi.mock('./key-store.js', async (orig) => ({
  ...(await orig<typeof import('./key-store.js')>()),
  readKeptDkimPrivateKey: (...a: unknown[]) => readKept(...a),
}));
const assertFreshStepUp = vi.fn();
vi.mock('../auth/step-up-service.js', async (orig) => ({
  ...(await orig<typeof import('../auth/step-up-service.js')>()),
  assertFreshStepUp: (...a: unknown[]) => assertFreshStepUp(...a),
}));

const { emailDkimKeysRoutes } = await import('./keys-routes.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const EMAIL_DOMAIN = '33333333-3333-4333-8333-333333333333';
const url = (t = TENANT) => `/api/v1/tenants/${t}/email-domains/${EMAIL_DOMAIN}/dkim/private-key`;

let ownerRows: unknown[] = [];
const audits: Record<string, unknown>[] = [];
const fakeDb = {
  select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => ownerRows }) }) }),
  insert: () => ({ values: async (v: Record<string, unknown>) => { audits.push(v); } }),
};

describe('DKIM private-key route', () => {
  let app: FastifyInstance;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', fakeDb as never);
    await app.register(emailDkimKeysRoutes, { prefix: '/api/v1' });
    await app.ready();
    const iat = Math.floor(Date.now() / 1000);
    tokens.tenant = app.jwt.sign({ sub: 'u1', role: 'tenant_admin', panel: 'tenant', tenantId: TENANT, iat });
    tokens.other = app.jwt.sign({ sub: 'u2', role: 'tenant_admin', panel: 'tenant', tenantId: OTHER_TENANT, iat });
    tokens.user = app.jwt.sign({ sub: 'u3', role: 'tenant_user', panel: 'tenant', tenantId: TENANT, iat });
    tokens.support = app.jwt.sign({ sub: 's1', role: 'support', panel: 'admin', iat });
    tokens.admin = app.jwt.sign({ sub: 'a1', role: 'super_admin', panel: 'admin', iat });
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    ownerRows = [{ domainId: 'd1', domainName: 'example.test', stalwartDomainId: 'sd1', activeSelector: 'dkim-1' }];
    audits.length = 0;
    assertFreshStepUp.mockReset().mockResolvedValue(undefined);
    readKept.mockReset().mockResolvedValue({ ok: true, privateKeyPem: PEM });
    dkimSignatureGet.mockReset().mockResolvedValue([
      { id: 's1', '@type': 'Dkim1RsaSha256', domainId: 'sd1', selector: 'dkim-1', stage: 'active', publicKey: SPKI, privateKey: { '@type': 'Text', secret: '****' } },
    ]);
  });

  const get = (token: string, u = url()) => app.inject({ method: 'GET', url: u, headers: { authorization: `Bearer ${token}` } });

  it('hands the signing key to the tenant admin, never cached, and audits it without the key', async () => {
    const res = await get(tokens.tenant);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json().data).toEqual({
      domain: 'example.test', selector: 'dkim-1', algorithm: 'rsa',
      txtRecordName: 'dkim-1._domainkey.example.test', published: true, privateKeyPem: PEM,
    });
    expect(assertFreshStepUp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sub: 'u1' }), 'dkim_private_key');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: TENANT, resourceType: 'dkim_private_key', resourceId: EMAIL_DOMAIN, actorId: 'u1' });
    expect(JSON.stringify(audits[0])).not.toContain('PRIVATE KEY');
  });

  it('refuses without a fresh step-up, before touching the mail server', async () => {
    assertFreshStepUp.mockRejectedValue(new ApiError('STEP_UP_REQUIRED', 'Confirm it is you', 403, { methods: ['password'] }));
    const res = await get(tokens.tenant);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(res.json().error.details.methods).toEqual(['password']);
    expect(dkimSignatureGet).not.toHaveBeenCalled();
    expect(readKept).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('refuses another tenant, a tenant user and read-only support', async () => {
    expect((await get(tokens.other)).statusCode).toBe(403);
    expect((await get(tokens.user)).statusCode).toBe(403);
    expect((await get(tokens.support)).statusCode).toBe(403);
    expect(assertFreshStepUp).not.toHaveBeenCalled();
  });

  it('answers a domain that is not the tenant\'s with 404, before asking for a step-up', async () => {
    ownerRows = [];
    const res = await get(tokens.admin);
    expect(res.statusCode).toBe(404);
    expect(assertFreshStepUp).not.toHaveBeenCalled();
  });

  it('refuses a kept copy that is not the key the mail server signs with', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    readKept.mockResolvedValue({ ok: true, privateKeyPem: other });
    const res = await get(tokens.tenant);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.reason).toBe('mismatch');
    expect(res.body).not.toContain('PRIVATE KEY');
    expect(audits).toHaveLength(0);
  });

  it('explains a key made before copies were kept, and points at rotation', async () => {
    readKept.mockResolvedValue({ ok: false, reason: 'none' });
    const res = await get(tokens.tenant);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.reason).toBe('not_kept');
    expect(res.json().error.message).toMatch(/Rotate key/);
  });

  it('a mail-server failure is a plain 502', async () => {
    dkimSignatureGet.mockRejectedValue(new Error('connect ECONNREFUSED stalwart-mgmt.mail.svc.cluster.local:8080'));
    const res = await get(tokens.tenant);
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('stalwart-mgmt');
  });

  it('gives nothing when the audit row cannot be written', async () => {
    const insert = fakeDb.insert;
    fakeDb.insert = () => ({ values: async () => { throw new Error('db down'); } });
    try {
      const res = await get(tokens.tenant);
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('PRIVATE KEY');
    } finally {
      fakeDb.insert = insert;
    }
  });
});
