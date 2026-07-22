/**
 * Tenant-facing bandwidth routes. GET /tenants/:id/bandwidth is readable by the
 * tenant themselves (requireTenantAccess) plus staff roles — mirrors the
 * subscription route's per-route hook split. Mutations (limit/override) stay on
 * the admin plan/tenant endpoints.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { getBandwidthUsage } from './service.js';

export async function bandwidthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/tenants/:id/bandwidth — month-to-date usage vs effective limit.
  app.get('/tenants/:id/bandwidth', {
    onRequest: [
      requireRole('super_admin', 'admin', 'billing', 'support', 'tenant_admin', 'tenant_user'),
      requireTenantAccess(),
    ],
  }, async (request) => {
    const { id } = request.params as { id: string };
    return success(await getBandwidthUsage(app.db, id));
  });
}
