/**
 * The TOTP routes through Fastify with the service faked (the service's own
 * rules run against Postgres in totp-service.integration.test.ts). Proves who
 * may call what, the order of step 2, and that a session comes out of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { ApiError } from '../../shared/errors.js';

const calls: string[] = [];
const svc = vi.hoisted(() => ({
  getTotpStatus: vi.fn(),
  beginTotpSetup: vi.fn(),
  enableTotp: vi.fn(),
  disableTotp: vi.fn(),
  regenerateBackupCodes: vi.fn(),
  verifyTotpFactor: vi.fn(),
}));
vi.mock('./totp-service.js', () => svc);
const preAuth = vi.hoisted(() => ({ consumePreAuthToken: vi.fn() }));
vi.mock('./pre-auth.js', async (orig) => ({ ...(await orig<typeof import('./pre-auth.js')>()), ...preAuth }));
vi.mock('./session.js', () => ({
  issueSession: vi.fn(async () => ({ token: 'access', refreshToken: 'refresh', expiresIn: 1, refreshExpiresIn: 1, user: { id: 'u1' } })),
}));
vi.mock('../oidc/service.js', () => ({ isLocalAuthDisabled: vi.fn().mockResolvedValue(false) }));
vi.mock('../system-settings/service.js', () => ({ getSettings: vi.fn().mockResolvedValue({ platformName: 'Insula' }) }));

const { totpRoutes } = await import('./totp-routes.js');
const { signPreAuthToken } = await import('./pre-auth.js');

const activeUser = { id: 'u1', email: 'ada@example.test', fullName: 'Ada', roleName: 'admin', panel: 'admin', tenantId: null, status: 'active' };
const db = {
  select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [activeUser] }) }) })),
  insert: vi.fn(() => ({ values: async () => undefined })),
};

let app: FastifyInstance;
const KEY = 'a'.repeat(64);

beforeAll(async () => {
  app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
  app.setErrorHandler(errorHandler);
  app.decorate('db', db as never);
  app.decorate('config', { PLATFORM_ENCRYPTION_KEY: KEY } as never);
  await app.register(totpRoutes, { prefix: '/api/v1' });
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  svc.verifyTotpFactor.mockImplementation(async () => { calls.push('verify'); return 'code'; });
  preAuth.consumePreAuthToken.mockImplementation(async () => { calls.push('consume'); });
});

const now = () => Math.floor(Date.now() / 1000);
const bearer = (claims: Record<string, unknown>) => ({
  authorization: `Bearer ${app.jwt.sign({ sub: 'u1', role: 'admin', panel: 'admin', iat: now(), exp: now() + 60, ...claims })}`,
});

describe('managing TOTP', () => {
  it('belongs to the signed-in owner: no token, a step token, or an impersonation token is refused', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/totp' })).statusCode).toBe(401);
    const step = signPreAuthToken(app, { userId: 'u1', panel: 'admin', step: 'totp_2fa' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/totp/setup', headers: { authorization: `Bearer ${step}` } })).statusCode).toBe(401);
    const imp = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/setup', headers: bearer({ impersonatedBy: 'admin-9' }) });
    expect(imp.statusCode).toBe(403);
    expect(imp.json().error.code).toBe('IMPERSONATION_FORBIDDEN');
    expect(svc.beginTotpSetup).not.toHaveBeenCalled();
  });

  it('labels the authenticator entry with the platform name — "Admin" for the admin panel', async () => {
    svc.beginTotpSetup.mockResolvedValue({ secret: 'S', otpauthUri: 'otpauth://x' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/setup', headers: bearer({}) });
    expect(res.statusCode).toBe(200);
    expect(svc.beginTotpSetup).toHaveBeenCalledWith(db, KEY, { userId: 'u1', account: 'ada@example.test', issuer: 'Insula Admin' });
  });

  it('enables with a 6-digit code and returns the backup codes', async () => {
    svc.enableTotp.mockResolvedValue(['AAAAA-BBBBB']);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/enable', headers: bearer({}), payload: { code: '12ab56' } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/enable', headers: bearer({}), payload: { code: '123 456' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.backupCodes).toEqual(['AAAAA-BBBBB']);
  });

  it('turning off or regenerating needs exactly one proof', async () => {
    for (const url of ['/api/v1/auth/totp/disable', '/api/v1/auth/totp/backup-codes']) {
      expect((await app.inject({ method: 'POST', url, headers: bearer({}), payload: {} })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url, headers: bearer({}), payload: { code: '123456', backup_code: 'AAAAA-BBBBB' } })).statusCode).toBe(400);
    }
    const off = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/disable', headers: bearer({}), payload: { backup_code: 'aaaaa-bbbbb' } });
    expect(off.statusCode).toBe(200);
    expect(svc.disableTotp).toHaveBeenCalledWith(db, KEY, 'u1', { backupCode: 'aaaaa-bbbbb' });
  });
});

describe('step 2 of a password sign-in', () => {
  const verify = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/auth/totp/login/verify', payload });

  it('checks the factor BEFORE using up the step token, then issues a session', async () => {
    const pre = signPreAuthToken(app, { userId: 'u1', panel: 'admin', step: 'totp_2fa' });
    const res = await verify({ pre_auth_token: pre, code: '123456', panel: 'admin' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.token).toBe('access');
    expect(calls).toEqual(['verify', 'consume']);
  });

  it('a wrong code keeps the step token — the user retypes the code, not the password', async () => {
    svc.verifyTotpFactor.mockRejectedValueOnce(new ApiError('TOTP_CODE_INVALID', 'no', 401));
    const pre = signPreAuthToken(app, { userId: 'u1', panel: 'admin', step: 'totp_2fa' });
    const res = await verify({ pre_auth_token: pre, code: '000000' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('TOTP_CODE_INVALID');
    expect(preAuth.consumePreAuthToken).not.toHaveBeenCalled();
  });

  it('refuses an access token, a token for the other panel, and garbage — before looking at the code', async () => {
    const access = app.jwt.sign({ sub: 'u1', role: 'admin', panel: 'admin', iat: now(), exp: now() + 60 });
    expect((await verify({ pre_auth_token: access, code: '123456' })).json().error.code).toBe('PRE_AUTH_TOKEN_INVALID');
    const tenantStep = signPreAuthToken(app, { userId: 'u1', panel: 'tenant', step: 'totp_2fa' });
    expect((await verify({ pre_auth_token: tenantStep, code: '123456', panel: 'admin' })).json().error.code).toBe('PRE_AUTH_TOKEN_PANEL_MISMATCH');
    expect((await verify({ pre_auth_token: 'nope', code: '123456' })).json().error.code).toBe('PRE_AUTH_TOKEN_INVALID');
    expect(svc.verifyTotpFactor).not.toHaveBeenCalled();
  });

  it('takes a backup code instead of a live code', async () => {
    const pre = signPreAuthToken(app, { userId: 'u1', panel: 'admin', step: 'totp_2fa' });
    const res = await verify({ pre_auth_token: pre, backup_code: 'AAAAA-BBBBB' });
    expect(res.statusCode).toBe(200);
    expect(svc.verifyTotpFactor).toHaveBeenCalledWith(db, KEY, 'u1', { backupCode: 'AAAAA-BBBBB' });
  });
});
