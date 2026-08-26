import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { createMailboxAliasSchema, updateMailboxAliasSchema } from '@insula/api-contracts';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function mailboxAliasRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support', 'tenant_admin'));
  app.addHook('onRequest', requireTenantAccess());

  // GET /api/v1/tenants/:tenantId/email/mailbox-aliases?mailbox_id=&email_domain_id=
  app.get('/tenants/:tenantId/email/mailbox-aliases', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const aliases = await service.listMailboxAliases(app.db, tenantId, {
      mailboxId: typeof query.mailbox_id === 'string' ? query.mailbox_id : undefined,
      emailDomainId: typeof query.email_domain_id === 'string' ? query.email_domain_id : undefined,
    });
    return success(aliases);
  });

  // POST /api/v1/tenants/:tenantId/email/mailboxes/:mailboxId/aliases
  app.post('/tenants/:tenantId/email/mailboxes/:mailboxId/aliases', async (request, reply) => {
    const { tenantId, mailboxId } = request.params as { tenantId: string; mailboxId: string };
    const parsed = createMailboxAliasSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const alias = await service.createMailboxAlias(app.db, tenantId, mailboxId, parsed.data);
    reply.status(201).send(success(alias));
  });

  // PATCH /api/v1/tenants/:tenantId/email/mailbox-aliases/:id
  app.patch('/tenants/:tenantId/email/mailbox-aliases/:id', async (request) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const parsed = updateMailboxAliasSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const updated = await service.updateMailboxAlias(app.db, tenantId, id, parsed.data);
    return success(updated);
  });

  // DELETE /api/v1/tenants/:tenantId/email/mailbox-aliases/:id
  app.delete('/tenants/:tenantId/email/mailbox-aliases/:id', async (request, reply) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    await service.deleteMailboxAlias(app.db, tenantId, id);
    reply.status(204).send();
  });
}
