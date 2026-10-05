/**
 * GET /admin/backup-health — the roll-up behind the Backups dashboard cards.
 *
 * The bug this pins: the route returned ONLY health-labelled Kubernetes Jobs.
 * No tenant backup is such a Job (bundles live in `backup_jobs`), so the
 * Tenants card read "0 · no jobs registered" beside hundreds of bundles. The
 * route must merge the tenant bundle rows in, in the roll-up's one order.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import { LABEL_CATEGORY, LABEL_HEALTH_WATCH } from '../backup-health/labels.js';

const listJobForAllNamespaces = vi.fn();
vi.mock('../k8s-provisioner/k8s-client.js', () => ({
  createK8sClients: () => ({ core: {}, custom: {}, batch: { listJobForAllNamespaces } }),
}));

const loadTenantBundleHealth = vi.fn();
vi.mock('../backup-health/tenant-bundles.js', () => ({
  loadTenantBundleHealth: (...a: unknown[]) => loadTenantBundleHealth(...a),
}));

const { backupConfigRoutes } = await import('./routes.js');

const TENANT = '11111111-1111-4111-8111-111111111111';

function drJob(name: string, ok: boolean) {
  return {
    metadata: {
      uid: `uid-${name}`, name: `${name}-1`, namespace: 'platform',
      labels: { [LABEL_HEALTH_WATCH]: 'true', [LABEL_CATEGORY]: 'dr' },
      ownerReferences: [{ kind: 'CronJob', name, apiVersion: 'batch/v1', uid: `cj-${name}` }],
    },
    status: {
      startTime: new Date('2026-10-04T03:00:00Z'),
      completionTime: new Date('2026-10-04T03:01:00Z'),
      conditions: [{ type: ok ? 'Complete' : 'Failed', status: 'True' }],
    },
  };
}

describe('GET /admin/backup-health', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', { marker: 'db' });
    app.decorate('config', { PLATFORM_ENCRYPTION_KEY: '0'.repeat(64) });
    await app.register(backupConfigRoutes, { prefix: '/api/v1' });
    await app.ready();
    token = app.jwt.sign({ sub: 'admin-1', role: 'admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => { await app.close(); });

  it('lists tenant bundle rows beside the Job rows, failing first', async () => {
    listJobForAllNamespaces.mockResolvedValue({ items: [drJob('etcd-snap-via-shim', true)] });
    loadTenantBundleHealth.mockResolvedValue([{
      groupKey: `tenant-bundles/${TENANT}`, displayName: 'Acme', namespace: 'tenant-example-0a1b2c3d',
      category: 'tenant', severity: 'warning', tenantId: TENANT, state: 'failing',
      lastSuccessAt: null, lastFailedAt: new Date('2026-10-04T02:05:00Z'), lastFailedReason: 'target unreachable',
      recentRuns: 1,
    }]);

    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/backup-health', headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ groupKey: string; category: string; state: string; lastFailedAt: string }>;
    expect(rows.map((r) => `${r.category}:${r.groupKey}:${r.state}`)).toEqual([
      `tenant:tenant-bundles/${TENANT}:failing`,
      'dr:etcd-snap-via-shim:healthy',
    ]);
    expect(rows[0].lastFailedAt).toBe('2026-10-04T02:05:00.000Z');
    // The ledger is read from the app's own database handle.
    expect(loadTenantBundleHealth).toHaveBeenCalledWith(app.db);
  });

  it('with no labelled Jobs at all, the tenant rows still come back', async () => {
    listJobForAllNamespaces.mockResolvedValue({ items: [] });
    loadTenantBundleHealth.mockResolvedValue([{
      groupKey: `tenant-bundles/${TENANT}`, displayName: 'Acme', namespace: 'tenant-example-0a1b2c3d',
      category: 'tenant', severity: 'warning', tenantId: TENANT, state: 'healthy',
      lastSuccessAt: new Date('2026-10-04T02:05:00Z'), lastFailedAt: null, lastFailedReason: null, recentRuns: 4,
    }]);

    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/backup-health', headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([expect.objectContaining({ category: 'tenant', state: 'healthy', recentRuns: 4 })]);
  });
});
