/**
 * The database backup status routes: who may read what, what a tenant is
 * shown, and that every list is a bounded keyset page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import type { SweepRow } from './sweep.js';

const loadRowPage = vi.fn();
vi.mock('./sweep.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sweep.js')>()),
  loadRowPage: (...a: unknown[]) => loadRowPage(...a),
}));

const { databaseBackupStatusAdminRoutes, databaseBackupStatusTenantRoutes } = await import('./routes.js');

function row(over: Partial<SweepRow> = {}): SweepRow {
  return {
    tenantId: 't1', tenantName: 'Acme Ltd', instanceState: 'active', subjectKey: 'dep-1', databaseName: 'shop', deploymentId: 'dep-1',
    deploymentName: 'my-mariadb', engine: 'mariadb', lastAttemptAt: new Date('2026-11-26T01:50:00Z'),
    lastAttemptBundleId: 'bkp-9', lastStatus: 'failed',
    lastError: "ERROR 1045 (28000): Access denied for user 'root'@'10.42.3.7'; diagnosis: pod pinned to node-a; logs: secret",
    lastSuccessAt: null, lastSuccessBundleId: null, lastSuccessSizeBytes: null,
    staleSince: new Date('2026-11-26T04:00:00Z'), alertedAt: null, lastAlertedAt: null, createdAt: new Date('2026-11-01T00:00:00Z'), ...over,
  };
}

describe('database backup status routes', () => {
  let app: FastifyInstance;
  const sign = (claims: Record<string, unknown>) => app.jwt.sign({ sub: 'u1', iat: Math.floor(Date.now() / 1000), ...claims });
  const tenantToken = () => sign({ role: 'tenant_admin', panel: 'tenant', tenantId: 't1' });
  const adminToken = () => sign({ role: 'admin', panel: 'admin' });

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', { marker: 'db' });
    await app.register(databaseBackupStatusAdminRoutes, { prefix: '/api/v1' });
    await app.register(databaseBackupStatusTenantRoutes, { prefix: '/api/v1' });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    loadRowPage.mockReset();
    loadRowPage.mockResolvedValue({ rows: [row(), row({ databaseName: 'crm', staleSince: null, instanceState: 'stopped' })], hasMore: false });
  });

  const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('a tenant reads its own databases with a failure category, never the error text', async () => {
    const res = await get('/api/v1/tenant/backups/databases', tenantToken());
    expect(res.statusCode).toBe(200);
    expect(loadRowPage).toHaveBeenCalledWith(app.db, { tenantId: 't1' }, { limit: 100 });
    const body = res.json();
    expect(body.pagination).toMatchObject({ has_more: false, cursor: null, page_size: 100 });
    expect(body.data[0]).toMatchObject({
      databaseName: 'shop', overdue: true, instanceState: 'active', lastErrorKind: 'access_denied',
      lastErrorLabel: 'The platform could not log in to the database.',
    });
    expect(body.data[1]).toMatchObject({ databaseName: 'crm', instanceState: 'stopped' });
    expect(JSON.stringify(body)).not.toMatch(/10\.42|node-a|secret|1045|lastError"|tenantName/);
  });

  it('the tenant route ignores any tenant in the URL and refuses a token without one', async () => {
    await get('/api/v1/tenant/backups/databases?tenantId=t2', tenantToken());
    expect(loadRowPage).toHaveBeenCalledWith(app.db, { tenantId: 't1' }, { limit: 100 });
    expect((await get('/api/v1/tenant/backups/databases', sign({ role: 'tenant_admin', panel: 'tenant' }))).statusCode).toBe(403);
  });

  it('pages: a next cursor when there is more, which the next request decodes; bad limits and cursors are refused', async () => {
    loadRowPage.mockResolvedValueOnce({ rows: [row({ databaseName: 'a' }), row({ databaseName: 'b', staleSince: null })], hasMore: true });
    const first = (await get('/api/v1/tenant/backups/databases?limit=2', tenantToken())).json();
    expect(first.pagination).toMatchObject({ has_more: true, page_size: 2 });
    expect(first.pagination.cursor).toEqual(expect.any(String));
    await get(`/api/v1/tenant/backups/databases?limit=2&cursor=${first.pagination.cursor}`, tenantToken());
    expect(loadRowPage).toHaveBeenLastCalledWith(app.db, { tenantId: 't1' }, { limit: 2, after: ['1', 'dep-1', 'b'] });

    expect((await get('/api/v1/tenant/backups/databases?limit=500', tenantToken())).statusCode).toBe(400);
    expect((await get('/api/v1/tenant/backups/databases?cursor=bm9wZQ', tenantToken())).statusCode).toBe(400);
    // A fleet cursor is no good for a tenant list.
    loadRowPage.mockResolvedValueOnce({ rows: [row()], hasMore: true });
    const fleet = (await get('/api/v1/admin/database-backups/overdue?limit=1', adminToken())).json();
    expect((await get(`/api/v1/tenant/backups/databases?cursor=${fleet.pagination.cursor}`, tenantToken())).statusCode).toBe(400);
  });

  it('an admin token cannot use the tenant route, nor a tenant token the admin routes', async () => {
    expect((await get('/api/v1/tenant/backups/databases', adminToken())).statusCode).toBe(403);
    expect((await get('/api/v1/admin/database-backups/overdue', tenantToken())).statusCode).toBe(403);
    expect((await get('/api/v1/admin/tenants/t1/database-backups', sign({ role: 'support', panel: 'admin' }))).statusCode).toBe(403);
    expect(loadRowPage).not.toHaveBeenCalled();
  });

  it('an admin reads one tenant with the full error, the tenant named, and the category too', async () => {
    const res = await get('/api/v1/admin/tenants/t1/database-backups', adminToken());
    expect(res.statusCode).toBe(200);
    expect(loadRowPage).toHaveBeenCalledWith(app.db, { tenantId: 't1' }, { limit: 100 });
    expect(res.json().data[0]).toMatchObject({ tenantName: 'Acme Ltd', lastErrorKind: 'access_denied', lastError: expect.stringMatching(/logs: secret$/) });
  });

  it('the fleet list is the overdue databases, one bounded page at a time', async () => {
    const ok = await get('/api/v1/admin/database-backups/overdue', sign({ role: 'super_admin', panel: 'admin' }));
    expect(ok.statusCode).toBe(200);
    expect(loadRowPage).toHaveBeenCalledWith(app.db, { staleOnly: true }, { limit: 100 });
  });
});
