import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import * as service from './service.js';

export async function backupsOverviewRoutes(app: FastifyInstance): Promise<void> {
  const adminGate = [authenticate, requireRole('super_admin', 'admin')];

  app.get('/admin/backups/system/overview', {
    onRequest: adminGate,
    schema: {
      tags: ['Backups Overview'],
      summary: 'Aggregate overview for the /backups/system page',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    return success(await service.loadSystemOverview(app.db));
  });

  app.get('/admin/backups/tenants/overview', {
    onRequest: adminGate,
    schema: {
      tags: ['Backups Overview'],
      summary: 'Paged tenant rollup for the /backups/tenants page',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const q = request.query as { limit?: string; cursor?: string; filter?: string };
    return success(await service.loadTenantsOverview(app.db, {
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      cursor: q.cursor,
      filter: q.filter,
    }));
  });

  // B2 (2026-05-22): cross-tenant flat-aggregate list of tenant
  // snapshots, one row per `storage_snapshots` entry joined to its
  // tenant. Drives the `/backups/tenants` Snapshots tab.
  app.get('/admin/backups/tenants/snapshots', {
    onRequest: adminGate,
    schema: {
      tags: ['Backups Overview'],
      summary: 'Flat snapshot list across all tenants (with tenant name + plan)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const q = request.query as { tenantId?: string; limit?: string };
    const limit = q.limit ? Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 500) : 200;
    return success(await service.listTenantSnapshots(app.db, {
      tenantId: q.tenantId,
      limit,
    }));
  });

  app.get('/admin/backups/tenants/:tenantId/overview', {
    onRequest: adminGate,
    schema: {
      tags: ['Backups Overview'],
      summary: 'Single-tenant deep view for /backups/tenants/:id',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const detail = await service.loadTenantDetail(app.db, tenantId);
    if (!detail) throw new ApiError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);
    return success(detail);
  });
}
