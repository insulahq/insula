import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess, requireTenantRoleByMethod } from '../../middleware/auth.js';
import {
  createProtectedDirectorySchema,
  updateProtectedDirectorySchema,
  createProtectedDirectoryUserSchema,
  changeProtectedDirectoryUserPasswordSchema,
} from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function protectedDirectoryRoutes(app: FastifyInstance): Promise<void> {
  // Phase 6: method-aware role guard — read open, writes staff+tenant_admin only
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  const base = '/tenants/:tenantId/domains/:domainId/protected-directories';

  // GET — list directories
  app.get(base, async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const dirs = await service.listDirectories(app.db, tenantId, domainId);
    return success(dirs);
  });

  // POST — create directory
  app.post(base, async (request, reply) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const parsed = createProtectedDirectorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('MISSING_REQUIRED_FIELD', `Validation error: ${parsed.error.issues[0].message}`, 400);
    }
    const dir = await service.createDirectory(app.db, tenantId, domainId, parsed.data);
    reply.status(201).send(success(dir));
  });

  // GET — get single directory
  app.get(`${base}/:dirId`, async (request) => {
    const { tenantId, domainId, dirId } = request.params as { tenantId: string; domainId: string; dirId: string };
    const dir = await service.getDirectory(app.db, tenantId, domainId, dirId);
    return success(dir);
  });

  // PATCH — update directory
  app.patch(`${base}/:dirId`, async (request) => {
    const { tenantId, domainId, dirId } = request.params as { tenantId: string; domainId: string; dirId: string };
    const parsed = updateProtectedDirectorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD_VALUE', `Validation error: ${parsed.error.issues[0].message}`, 400);
    }
    const updated = await service.updateDirectory(app.db, tenantId, domainId, dirId, parsed.data);
    return success(updated);
  });

  // DELETE — delete directory
  app.delete(`${base}/:dirId`, async (request, reply) => {
    const { tenantId, domainId, dirId } = request.params as { tenantId: string; domainId: string; dirId: string };
    await service.deleteDirectory(app.db, tenantId, domainId, dirId);
    reply.status(204).send();
  });

  // ─── Directory Users ─────────────────────────────────────────────────────

  // GET — list directory users
  app.get(`${base}/:dirId/users`, async (request) => {
    const { tenantId, domainId, dirId } = request.params as { tenantId: string; domainId: string; dirId: string };
    const users = await service.listDirectoryUsers(app.db, tenantId, domainId, dirId);
    return success(users);
  });

  // POST — create directory user
  app.post(`${base}/:dirId/users`, async (request, reply) => {
    const { tenantId, domainId, dirId } = request.params as { tenantId: string; domainId: string; dirId: string };
    const parsed = createProtectedDirectoryUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('MISSING_REQUIRED_FIELD', `Validation error: ${parsed.error.issues[0].message}`, 400);
    }
    const user = await service.createDirectoryUser(app.db, tenantId, domainId, dirId, parsed.data);
    reply.status(201).send(success(user));
  });

  // POST — change directory user password
  app.post(`${base}/:dirId/users/:userId/change-password`, async (request) => {
    const { tenantId, domainId, dirId, userId } = request.params as {
      tenantId: string; domainId: string; dirId: string; userId: string;
    };
    const parsed = changeProtectedDirectoryUserPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD_VALUE', `Validation error: ${parsed.error.issues[0].message}`, 400);
    }
    await service.changeDirectoryUserPassword(app.db, tenantId, domainId, dirId, userId, parsed.data.password);
    return success({ message: 'Password updated' });
  });

  // POST — disable directory user
  app.post(`${base}/:dirId/users/:userId/disable`, async (request) => {
    const { tenantId, domainId, dirId, userId } = request.params as {
      tenantId: string; domainId: string; dirId: string; userId: string;
    };
    await service.toggleDirectoryUser(app.db, tenantId, domainId, dirId, userId, false);
    return success({ message: 'User disabled' });
  });

  // DELETE — delete directory user
  app.delete(`${base}/:dirId/users/:userId`, async (request, reply) => {
    const { tenantId, domainId, dirId, userId } = request.params as {
      tenantId: string; domainId: string; dirId: string; userId: string;
    };
    await service.deleteDirectoryUser(app.db, tenantId, domainId, dirId, userId);
    reply.status(204).send();
  });
}
