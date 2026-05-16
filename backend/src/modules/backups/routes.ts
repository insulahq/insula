import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess, requireTenantRoleByMethod } from '../../middleware/auth.js';
import { createBackupSchema } from './schema.js';
import * as service from './service.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  // Phase 6: method-aware role guard — read for all tenant roles,
  // writes only for tenant_admin + staff.
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  // GET /api/v1/tenants/:id/backups
  app.get('/tenants/:id/backups', async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePaginationParams(query);

    const result = await service.listBackups(app.db, id, { limit, cursor });
    return paginated(result.data, result.pagination);
  });

  // POST /api/v1/tenants/:id/backups
  app.post('/tenants/:id/backups', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = createBackupSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const backup = await service.createBackup(app.db, id, parsed.data);
    reply.status(201).send(success(backup));
  });

  // DELETE /api/v1/tenants/:id/backups/:backupId
  app.delete('/tenants/:id/backups/:backupId', async (request, reply) => {
    const { id, backupId } = request.params as { id: string; backupId: string };
    await service.deleteBackup(app.db, id, backupId);
    reply.status(204).send();
  });
}
