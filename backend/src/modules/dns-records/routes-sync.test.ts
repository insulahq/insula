/**
 * Sync Records' routes: remove-local, remove-remote, sync (now an import) and
 * push with `replaces`. Role and secondary-zone gates included — they are
 * hooks and an assertion in routes.ts, not something the service checks.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const service = vi.hoisted(() => ({
  importRemoteOnlyRecords: vi.fn().mockResolvedValue([]),
  removeLocalDnsRecord: vi.fn().mockResolvedValue(undefined),
  removeRemoteDnsRecord: vi.fn().mockResolvedValue(undefined),
  syncRecordToProviders: vi.fn().mockResolvedValue({ status: 'published', servers: 1 }),
  describeSyncFailure: vi.fn(() => 'refused'),
}));
vi.mock('./service.js', () => service);
vi.mock('../../db/schema.js', () => ({ domains: { id: 'id', tenantId: 'tenantId', dnsMode: 'dnsMode' } }));

const { dnsRecordRoutes } = await import('./routes.js');

let dnsMode = 'primary';
let app: FastifyInstance;
let admin = '';
let reader = '';

beforeAll(async () => {
  app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
  registerAuth(app);
  app.setErrorHandler(errorHandler);
  app.decorate('db', {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => [{ id: 'd1', tenantId: 'c1', domainName: 'example.test', dnsMode }]) })) })),
  });
  await app.register(dnsRecordRoutes, { prefix: '/api/v1' });
  await app.ready();
  const iat = Math.floor(Date.now() / 1000);
  admin = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat });
  reader = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat });
});
afterAll(async () => { await app.close(); });
beforeEach(() => { vi.clearAllMocks(); dnsMode = 'primary'; });

const post = (path: string, body: unknown, token = admin) => app.inject({
  method: 'POST',
  url: `/api/v1/tenants/c1/domains/d1/dns-records/${path}`,
  headers: { authorization: `Bearer ${token}` },
  payload: body as object,
});

describe('remove-local', () => {
  it('drops the local row through the service', async () => {
    const res = await post('remove-local', { local_id: 'r1' });
    expect(res.statusCode, res.body).toBe(200);
    expect(service.removeLocalDnsRecord).toHaveBeenCalledWith(expect.anything(), 'c1', 'd1', 'r1');
  });
  it('a read-only role, a secondary zone, a bad body: refused before the service', async () => {
    expect((await post('remove-local', { local_id: 'r1' }, reader)).statusCode).toBe(403);
    dnsMode = 'secondary';
    expect((await post('remove-local', { local_id: 'r1' })).statusCode).toBe(403);
    dnsMode = 'primary';
    expect((await post('remove-local', { local_id: 'r1', extra: 1 })).statusCode).toBe(400);
    expect(service.removeLocalDnsRecord).not.toHaveBeenCalled();
  });
});

describe('remove-remote', () => {
  it('withdraws the one value through the service', async () => {
    const res = await post('remove-remote', { type: 'CNAME', name: 'webmail', value: 'old.platform.test.' });
    expect(res.statusCode, res.body).toBe(200);
    expect(service.removeRemoteDnsRecord).toHaveBeenCalledWith(expect.anything(), 'c1', 'd1', {
      type: 'CNAME', name: 'webmail', value: 'old.platform.test.',
    });
  });
  it('a read-only role or a secondary zone: refused', async () => {
    expect((await post('remove-remote', { type: 'A', name: 'x', value: '203.0.113.1' }, reader)).statusCode).toBe(403);
    dnsMode = 'secondary';
    expect((await post('remove-remote', { type: 'A', name: 'x', value: '203.0.113.1' })).statusCode).toBe(403);
    expect(service.removeRemoteDnsRecord).not.toHaveBeenCalled();
  });
});

describe('sync', () => {
  it('imports — the destructive replace is gone', async () => {
    const res = await post('sync', {});
    expect(res.statusCode, res.body).toBe(200);
    expect(service.importRemoteOnlyRecords).toHaveBeenCalledWith(expect.anything(), 'c1', 'd1');
  });
});

describe('push', () => {
  it('with `replaces`: an update that withdraws the server\'s value', async () => {
    const res = await post('push', { type: 'CNAME', name: 'webmail', value: 'webmail.platform.test.', replaces: 'old.platform.test.' });
    expect(res.statusCode, res.body).toBe(200);
    expect(service.syncRecordToProviders).toHaveBeenCalledWith(
      expect.anything(), 'example.test', 'update',
      expect.objectContaining({ type: 'CNAME', name: 'webmail', content: 'webmail.platform.test.' }),
      'd1',
      { previous: { type: 'CNAME', name: 'webmail', content: 'old.platform.test.' }, withdrawOnFailure: true },
    );
  });
  it('without it: a plain create, as before', async () => {
    await post('push', { type: 'A', name: 'x', value: '203.0.113.1' });
    expect(service.syncRecordToProviders.mock.calls[0][2]).toBe('create');
  });
});
