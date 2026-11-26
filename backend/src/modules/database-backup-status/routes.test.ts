/**
 * The database backup status routes: who may read what, and what a tenant is
 * shown. The tenant route takes its tenant from the token and nowhere else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import type { SweepRow } from './sweep.js';

const loadRows = vi.fn();
vi.mock('./sweep.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sweep.js')>()),
  loadRows: (...a: unknown[]) => loadRows(...a),
}));

const { databaseBackupStatusAdminRoutes, databaseBackupStatusTenantRoutes } = await import('./routes.js');

function row(over: Partial<SweepRow> = {}): SweepRow {
  return {
    tenantId: 't1', tenantName: 'Acme Ltd', subjectKey: 'dep-1', databaseName: 'shop', deploymentId: 'dep-1',
    deploymentName: 'my-mariadb', engine: 'mariadb', lastAttemptAt: new Date('2026-11-26T01:50:00Z'),
    lastAttemptBundleId: 'bkp-9', lastStatus: 'failed', lastError: 'dump failed; diagnosis: pod pinned to node-a; logs: secret',
    lastSuccessAt: null, lastSuccessBundleId: null, lastSuccessSizeBytes: null,
    staleSince: new Date('2026-11-26T04:00:00Z'), alertedAt: null, createdAt: new Date('2026-11-01T00:00:00Z'), ...over,
  };
}

describe('database backup status routes', () => {
  let app: FastifyInstance;
  const sign = (claims: Record<string, unknown>) => app.jwt.sign({ sub: 'u1', iat: Math.floor(Date.now() / 1000), ...claims });

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
  beforeEach(() => { loadRows.mockReset(); loadRows.mockResolvedValue([row(), row({ databaseName: 'crm', staleSince: null })]); });

  const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('a tenant reads its own databases, overdue first, with operator-only detail cut from errors', async () => {
    const res = await get('/api/v1/tenant/backups/databases', sign({ role: 'tenant_admin', panel: 'tenant', tenantId: 't1' }));
    expect(res.statusCode).toBe(200);
    expect(loadRows).toHaveBeenCalledWith(app.db, { tenantId: 't1' });
    const dbs = res.json().data.databases;
    expect(dbs.map((d: { databaseName: string; overdue: boolean }) => [d.databaseName, d.overdue])).toEqual([['shop', true], ['crm', false]]);
    expect(dbs[0]).toMatchObject({ instanceLabel: 'my-mariadb (MariaDB)', lastError: 'dump failed', lastSuccessAt: null });
    expect(JSON.stringify(dbs)).not.toMatch(/node-a|secret|tenantName/);
  });

  it('the tenant route ignores any tenant in the URL and refuses a token without one', async () => {
    await get('/api/v1/tenant/backups/databases?tenantId=t2', sign({ role: 'tenant_admin', panel: 'tenant', tenantId: 't1' }));
    expect(loadRows).toHaveBeenCalledWith(app.db, { tenantId: 't1' });
    const res = await get('/api/v1/tenant/backups/databases', sign({ role: 'tenant_admin', panel: 'tenant' }));
    expect(res.statusCode).toBe(403);
  });

  it('an admin token cannot use the tenant route, nor a tenant token the admin routes', async () => {
    expect((await get('/api/v1/tenant/backups/databases', sign({ role: 'admin', panel: 'admin' }))).statusCode).toBe(403);
    expect((await get('/api/v1/admin/database-backups/overdue', sign({ role: 'tenant_admin', panel: 'tenant', tenantId: 't1' }))).statusCode).toBe(403);
    expect((await get('/api/v1/admin/tenants/t1/database-backups', sign({ role: 'support', panel: 'admin' }))).statusCode).toBe(403);
    expect(loadRows).not.toHaveBeenCalled();
  });

  it('an admin reads one tenant, with the full error and the tenant named', async () => {
    const res = await get('/api/v1/admin/tenants/t1/database-backups', sign({ role: 'admin', panel: 'admin' }));
    expect(res.statusCode).toBe(200);
    expect(loadRows).toHaveBeenCalledWith(app.db, { tenantId: 't1' });
    expect(res.json().data.databases[0]).toMatchObject({ tenantName: 'Acme Ltd', lastError: 'dump failed; diagnosis: pod pinned to node-a; logs: secret' });
  });

  it('the fleet list is the overdue databases, by tenant', async () => {
    loadRows.mockResolvedValue([row({ tenantId: 't2', tenantName: 'Beta GmbH' }), row()]);
    const ok = await get('/api/v1/admin/database-backups/overdue', sign({ role: 'super_admin', panel: 'admin' }));
    expect(ok.statusCode).toBe(200);
    expect(loadRows).toHaveBeenCalledWith(app.db, { staleOnly: true });
    expect(ok.json().data.databases.map((d: { tenantName: string }) => d.tenantName)).toEqual(['Acme Ltd', 'Beta GmbH']);
  });
});
