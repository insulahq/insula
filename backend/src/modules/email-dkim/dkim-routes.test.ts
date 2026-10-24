/**
 * The tenant panel's DKIM routes: the signing-keys list and rotation.
 *
 * What a TENANT sees is the point here — the mail server's own error text
 * names internal hosts, so it must reach staff only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const INTERNAL = 'connect ECONNREFUSED stalwart-mgmt.mail.svc.cluster.local:8080';

const dkimSignatureGet = vi.fn();
vi.mock('../stalwart-jmap/client.js', () => ({ dkimSignatureGet: (...a: unknown[]) => dkimSignatureGet(...a) }));
vi.mock('./signatures.js', async (orig) => ({
  ...(await orig<typeof import('./signatures.js')>()),
  resolveDkimAccountId: vi.fn().mockResolvedValue('acct'),
}));
const readPublishedDkimRecords = vi.fn();
vi.mock('./keys.js', async (orig) => ({
  ...(await orig<typeof import('./keys.js')>()),
  readPublishedDkimRecords: (...a: unknown[]) => readPublishedDkimRecords(...a),
}));
const rotateDkimKey = vi.fn();
vi.mock('./rotate.js', async (orig) => ({
  ...(await orig<typeof import('./rotate.js')>()),
  rotateDkimKey: (...a: unknown[]) => rotateDkimKey(...a),
}));

const { emailDkimKeysRoutes } = await import('./keys-routes.js');
const { emailDkimRotateRoutes } = await import('./rotate-routes.js');
const { DkimRotationError } = await import('./rotate.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const EMAIL_DOMAIN = '33333333-3333-4333-8333-333333333333';
const keysUrl = (t = TENANT) => `/api/v1/tenants/${t}/email-domains/${EMAIL_DOMAIN}/dkim/keys`;
const rotateUrl = `/api/v1/tenants/${TENANT}/email-domains/${EMAIL_DOMAIN}/dkim/rotate`;

let ownerRows: unknown[] = [];
let lastWhere: unknown = null;
const fakeDb = {
  select: () => ({ from: () => ({ innerJoin: () => ({ where: async (w: unknown) => { lastWhere = w; return ownerRows; } }) }) }),
};
/** The ownership lookup's WHERE clause as SQL — the fake db cannot apply it, so the test reads it. */
const ownershipWhere = () => new PgDialect().sqlToQuery(lastWhere as SQL);

describe('DKIM routes', () => {
  let app: FastifyInstance;
  let tenantToken: string;
  let otherTenantToken: string;
  let adminToken: string;
  let tenantUserToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', fakeDb as never);
    await app.register(emailDkimKeysRoutes, { prefix: '/api/v1' });
    await app.register(emailDkimRotateRoutes, { prefix: '/api/v1' });
    await app.ready();
    const iat = Math.floor(Date.now() / 1000);
    tenantToken = app.jwt.sign({ sub: 'u1', role: 'tenant_admin', panel: 'tenant', tenantId: TENANT, iat });
    otherTenantToken = app.jwt.sign({ sub: 'u2', role: 'tenant_admin', panel: 'tenant', tenantId: OTHER_TENANT, iat });
    tenantUserToken = app.jwt.sign({ sub: 'u3', role: 'tenant_user', panel: 'tenant', tenantId: TENANT, iat });
    adminToken = app.jwt.sign({ sub: 'a1', role: 'super_admin', panel: 'admin', iat });
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    ownerRows = [{ domainId: 'd1', domainName: 'example.test', stalwartDomainId: 'sd1', activeSelector: 'dkim-1' }];
    dkimSignatureGet.mockReset().mockResolvedValue([
      { id: 's1', '@type': 'Dkim1RsaSha256', domainId: 'sd1', selector: 'dkim-1', stage: 'active', privateKey: { secret: 'PEM' } },
      { id: 's9', '@type': 'Dkim1RsaSha256', domainId: 'someone-else', selector: 'dkim-1', stage: 'active' },
    ]);
    readPublishedDkimRecords.mockReset().mockResolvedValue([
      { name: 'dkim-1._domainkey.example.test', value: 'v=DKIM1; k=rsa; p=AAA', ttl: 3600 },
    ]);
    rotateDkimKey.mockReset();
  });

  const get = (token: string, url = keysUrl()) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('lists the domain\'s keys for its tenant admin, with nothing but the picked fields', async () => {
    const res = await get(tenantToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      provisioned: true,
      keys: [{
        selector: 'dkim-1', algorithm: 'rsa', stage: 'active', current: true,
        txtRecordName: 'dkim-1._domainkey.example.test', txtRecordValue: 'v=DKIM1; k=rsa; p=AAA',
      }],
    });
    expect(res.body).not.toContain('PEM');
  });

  it('refuses another tenant, and a tenant user', async () => {
    expect((await get(otherTenantToken, keysUrl(TENANT))).statusCode).toBe(403);
    expect((await get(tenantUserToken)).statusCode).toBe(403);
  });

  it('looks the email domain up by its id AND the path tenant, and 404s when that finds nothing', async () => {
    await get(tenantToken);
    const q = ownershipWhere();
    expect(q.sql).toMatch(/"email_domains"\."id" = \$\d+ and "domains"\."tenant_id" = \$\d+/);
    expect(q.params).toEqual([EMAIL_DOMAIN, TENANT]);

    ownerRows = [];
    const res = await get(adminToken);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('EMAIL_DOMAIN_NOT_FOUND');
  });

  it('says "not provisioned" without asking the mail server', async () => {
    ownerRows = [{ domainId: 'd1', domainName: 'example.test', stalwartDomainId: null, activeSelector: null }];
    const res = await get(tenantToken);
    expect(res.json().data).toEqual({ provisioned: false, keys: [] });
    expect(dkimSignatureGet).not.toHaveBeenCalled();
  });

  it('a mail-server failure is a 502 with a plain sentence, never the internal error', async () => {
    dkimSignatureGet.mockRejectedValue(new Error(INTERNAL));
    const res = await get(tenantToken);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('STALWART_UNREACHABLE');
    expect(res.body).not.toContain('stalwart-mgmt');
  });

  it('a rotation failure hides the mail server\'s text from a tenant but not from staff', async () => {
    rotateDkimKey.mockRejectedValue(new DkimRotationError(`Stalwart DkimSignature listing failed: ${INTERNAL}`, 'STALWART_API_ERROR'));
    ownerRows = [{ edId: EMAIL_DOMAIN, domainName: 'example.test', parentTenantId: TENANT }];

    const asTenant = await app.inject({ method: 'POST', url: rotateUrl, headers: { authorization: `Bearer ${tenantToken}` }, payload: {} });
    expect(asTenant.statusCode).toBe(502);
    expect(asTenant.body).not.toContain('stalwart-mgmt');
    expect(asTenant.json().error.message).toMatch(/current key keeps signing/);

    const asAdmin = await app.inject({ method: 'POST', url: rotateUrl, headers: { authorization: `Bearer ${adminToken}` }, payload: {} });
    expect(asAdmin.statusCode).toBe(502);
    expect(asAdmin.body).toContain('stalwart-mgmt');
  });

  it('an unclassified rotation failure (a raw mail-server error) is hidden from a tenant too', async () => {
    rotateDkimKey.mockRejectedValue(new Error(`JMAP request to http://${INTERNAL} failed: HTTP 503`));
    ownerRows = [{ edId: EMAIL_DOMAIN, domainName: 'example.test', parentTenantId: TENANT }];
    const res = await app.inject({ method: 'POST', url: rotateUrl, headers: { authorization: `Bearer ${tenantToken}` }, payload: {} });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('DKIM_ROTATION_FAILED');
    expect(res.body).not.toContain('stalwart-mgmt');
  });

  it('rotation checks ownership by the email-domain id AND the path tenant', async () => {
    rotateDkimKey.mockResolvedValue({ newSelector: 'dkim-2', previousSelector: 'dkim-1', newPublicKey: 'B', txtRecordName: 'n', txtRecordValue: 'v', stalwartDkimSignatureId: 's', destroyedSelectors: [] });
    ownerRows = [];
    const res = await app.inject({ method: 'POST', url: rotateUrl, headers: { authorization: `Bearer ${tenantToken}` }, payload: {} });
    expect(res.statusCode).toBe(404);
    const q = ownershipWhere();
    expect(q.sql).toMatch(/"email_domains"\."id" = \$\d+ and "domains"\."tenant_id" = \$\d+/);
    expect(q.params).toEqual([EMAIL_DOMAIN, TENANT]);
    expect(rotateDkimKey).not.toHaveBeenCalled();
  });
});
