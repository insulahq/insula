/**
 * POST …/dkim/restore (staff) and the lock on both DKIM write routes: a change
 * already running answers 409 instead of racing it, and every restore attempt
 * is audited — success, undecidable, busy or failed — with the tenant in its
 * column and who really acted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

vi.mock('./signatures.js', async (orig) => ({
  ...(await orig<typeof import('./signatures.js')>()),
  resolveDkimAccountId: vi.fn().mockResolvedValue('acct'),
}));
const convergeDomainDkim = vi.fn();
vi.mock('./converge.js', async (orig) => ({
  ...(await orig<typeof import('./converge.js')>()),
  convergeDomainDkim: (...a: unknown[]) => convergeDomainDkim(...a),
}));
const rotateDkimKey = vi.fn();
vi.mock('./rotate.js', async (orig) => ({
  ...(await orig<typeof import('./rotate.js')>()),
  rotateDkimKey: (...a: unknown[]) => rotateDkimKey(...a),
}));

const { emailDkimRotateRoutes } = await import('./rotate-routes.js');
const { DkimDomainBusyError } = await import('./lock.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMAIL_DOMAIN = '33333333-3333-4333-8333-333333333333';
const restoreUrl = `/api/v1/tenants/${TENANT}/email-domains/${EMAIL_DOMAIN}/dkim/restore`;
const rotateUrl = `/api/v1/tenants/${TENANT}/email-domains/${EMAIL_DOMAIN}/dkim/rotate`;

const audits: Array<Record<string, unknown>> = [];
const fakeDb = {
  select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => [{
    edId: EMAIL_DOMAIN, domainId: 'd1', domainName: 'example.test', stalwartDomainId: 'sd1', dkimActiveSelector: 'dkim-1',
    parentTenantId: TENANT,
  }] }) }) }),
  insert: () => ({ values: async (v: Record<string, unknown>) => { audits.push(v); } }),
};
const converged = (over: Record<string, unknown> = {}) => ({
  activeSelector: 'dkim-1', restored: ['dkim-2'], minted: false, txtPublished: false, keptCopy: null,
  undecidable: false, zoneHostedHere: true, ...over,
});

describe('DKIM restore route', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let tenantToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', fakeDb as never);
    await app.register(emailDkimRotateRoutes, { prefix: '/api/v1' });
    await app.ready();
    const iat = Math.floor(Date.now() / 1000);
    adminToken = app.jwt.sign({ sub: 'a1', role: 'super_admin', panel: 'admin', iat });
    tenantToken = app.jwt.sign({ sub: 'u1', role: 'tenant_admin', panel: 'tenant', tenantId: TENANT, iat });
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { audits.length = 0; convergeDomainDkim.mockReset(); rotateDkimKey.mockReset(); });

  const post = (url: string, token = adminToken) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: {} });

  it('restores without waiting for the lock, and audits the success with the tenant in its column', async () => {
    convergeDomainDkim.mockResolvedValue(converged());
    const res = await post(restoreUrl);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ restored: ['dkim-2'], message: expect.stringContaining('kept copies') });
    expect(convergeDomainDkim.mock.calls[0][1]).toMatchObject({ waitForLock: false, emailDomainId: EMAIL_DOMAIN });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: TENANT, actionType: 'email_domain.dkim.restore', actorId: 'a1' });
    expect(audits[0].changes).toMatchObject({ outcome: 'success', restored: ['dkim-2'] });
  });

  it('audits an undecidable run as such', async () => {
    convergeDomainDkim.mockResolvedValue(converged({ restored: [], undecidable: true, activeSelector: null }));
    expect((await post(restoreUrl)).statusCode).toBe(200);
    expect(audits[0].changes).toMatchObject({ outcome: 'undecidable' });
  });

  it('answers 409 while another DKIM change of the domain runs, and audits it', async () => {
    convergeDomainDkim.mockRejectedValue(new DkimDomainBusyError(EMAIL_DOMAIN));
    const res = await post(restoreUrl);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DKIM_CHANGE_IN_PROGRESS');
    expect(audits[0].changes).toMatchObject({ outcome: 'busy' });
  });

  it('audits a failure too', async () => {
    convergeDomainDkim.mockRejectedValue(new Error('stalwart down'));
    expect((await post(restoreUrl)).statusCode).toBe(502);
    expect(audits).toHaveLength(1);
    expect(audits[0].changes).toMatchObject({ outcome: 'failed', minted: false });
  });

  it('is staff only', async () => {
    expect((await post(restoreUrl, tenantToken)).statusCode).toBe(403);
    expect(convergeDomainDkim).not.toHaveBeenCalled();
  });

  it('rotation answers 409 too instead of racing a running change', async () => {
    rotateDkimKey.mockRejectedValue(new DkimDomainBusyError(EMAIL_DOMAIN));
    const res = await post(rotateUrl, tenantToken);
    expect(res.statusCode).toBe(409);
    expect(rotateDkimKey.mock.calls[0][3]).toMatchObject({ waitForLock: false });
  });
});
