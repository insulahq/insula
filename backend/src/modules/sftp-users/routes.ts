import type { FastifyInstance } from 'fastify';
import { authenticate, requireTenantRoleByMethod, requireTenantAccess } from '../../middleware/auth.js';
import { createSftpUserSchema, updateSftpUserSchema, rotateSftpPasswordSchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function sftpUserRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  // GET /api/v1/tenants/:tenantId/sftp-users
  app.get('/tenants/:tenantId/sftp-users', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const users = await service.listSftpUsers(app.db, tenantId);
    return success(users);
  });

  // POST /api/v1/tenants/:tenantId/sftp-users
  app.post('/tenants/:tenantId/sftp-users', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = createSftpUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${parsed.error.issues[0].message}`,
        400,
      );
    }
    const user = await service.createSftpUser(app.db, tenantId, parsed.data);
    reply.status(201).send(success(user));
  });

  // GET /api/v1/tenants/:tenantId/sftp-users/connection-info
  app.get('/tenants/:tenantId/sftp-users/connection-info', async () => {
    const info = await service.getSftpConnectionInfo(app.db);
    return success(info);
  });

  // GET /api/v1/tenants/:tenantId/sftp-users/:userId
  app.get('/tenants/:tenantId/sftp-users/:userId', async (request) => {
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };
    const user = await service.getSftpUser(app.db, tenantId, userId);
    return success(user);
  });

  // PATCH /api/v1/tenants/:tenantId/sftp-users/:userId
  app.patch('/tenants/:tenantId/sftp-users/:userId', async (request) => {
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };
    const parsed = updateSftpUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${parsed.error.issues[0].message}`,
        400,
      );
    }
    const user = await service.updateSftpUser(app.db, tenantId, userId, parsed.data);
    return success(user);
  });

  // DELETE /api/v1/tenants/:tenantId/sftp-users/:userId
  app.delete('/tenants/:tenantId/sftp-users/:userId', async (request, reply) => {
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };
    await service.deleteSftpUser(app.db, tenantId, userId);
    reply.status(204).send();
  });

  // POST /api/v1/tenants/:tenantId/sftp-users/:userId/rotate-password
  app.post('/tenants/:tenantId/sftp-users/:userId/rotate-password', async (request) => {
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };
    const parsed = rotateSftpPasswordSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${parsed.error.issues[0].message}`,
        400,
      );
    }
    const result = await service.rotateSftpPassword(
      app.db,
      tenantId,
      userId,
      parsed.data.custom_password,
    );
    return success(result);
  });

  // GET /api/v1/tenants/:tenantId/sftp-audit
  app.get('/tenants/:tenantId/sftp-audit', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const { items, total } = await service.listSftpAuditLog(app.db, tenantId, limit, offset);
    return { data: items, pagination: { total, limit, offset } };
  });
}
