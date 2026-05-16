import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess, requireTenantRoleByMethod } from '../../middleware/auth.js';
import { updateHostingSettingsSchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function hostingSettingsRoutes(app: FastifyInstance): Promise<void> {
  // Phase 6: method-aware role guard — read open, writes staff+tenant_admin only
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  // GET /api/v1/tenants/:tenantId/domains/:domainId/hosting-settings
  app.get('/tenants/:tenantId/domains/:domainId/hosting-settings', async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const settings = await service.getHostingSettings(app.db, tenantId, domainId);
    return success(settings);
  });

  // PATCH /api/v1/tenants/:tenantId/domains/:domainId/hosting-settings
  app.patch('/tenants/:tenantId/domains/:domainId/hosting-settings', async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const parsed = updateHostingSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateHostingSettings(app.db, tenantId, domainId, parsed.data);
    return success(updated);
  });
}
