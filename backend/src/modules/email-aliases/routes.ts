import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { createEmailAliasSchema, updateEmailAliasSchema } from '@k8s-hosting/api-contracts';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function emailAliasRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support', 'tenant_admin'));
  app.addHook('onRequest', requireTenantAccess());

  // GET /api/v1/tenants/:tenantId/email/aliases
  app.get('/tenants/:tenantId/email/aliases', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const emailDomainId = typeof query.email_domain_id === 'string' ? query.email_domain_id : undefined;

    const aliases = await service.listAliases(app.db, tenantId, emailDomainId);
    return success(aliases);
  });

  // POST /api/v1/tenants/:tenantId/email/domains/:emailDomainId/aliases
  app.post('/tenants/:tenantId/email/domains/:emailDomainId/aliases', async (request, reply) => {
    const { tenantId, emailDomainId } = request.params as { tenantId: string; emailDomainId: string };
    const parsed = createEmailAliasSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const alias = await service.createAlias(app.db, tenantId, emailDomainId, parsed.data);
    reply.status(201).send(success(alias));
  });

  // PATCH /api/v1/tenants/:tenantId/email/aliases/:id
  app.patch('/tenants/:tenantId/email/aliases/:id', async (request) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const parsed = updateEmailAliasSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateAlias(app.db, tenantId, id, parsed.data);
    return success(updated);
  });

  // DELETE /api/v1/tenants/:tenantId/email/aliases/:id
  app.delete('/tenants/:tenantId/email/aliases/:id', async (request, reply) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    await service.deleteAlias(app.db, tenantId, id);
    reply.status(204).send();
  });
}
