import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess, requireTenantRoleByMethod } from '../../middleware/auth.js';
import { createSshKeySchema, updateSshKeySchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function sshKeyRoutes(app: FastifyInstance): Promise<void> {
  // Phase 6: method-aware role guard — read for all tenant roles,
  // writes only for tenant_admin + staff.
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  // GET /api/v1/tenants/:tenantId/ssh-keys
  app.get('/tenants/:tenantId/ssh-keys', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const keys = await service.listSshKeys(app.db, tenantId);
    return success(keys);
  });

  // POST /api/v1/tenants/:tenantId/ssh-keys
  app.post('/tenants/:tenantId/ssh-keys', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = createSshKeySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('MISSING_REQUIRED_FIELD', `Validation error: ${parsed.error.issues[0].message}`, 400);
    }
    const key = await service.createSshKey(app.db, tenantId, parsed.data);
    reply.status(201).send(success(key));
  });

  // PATCH /api/v1/tenants/:tenantId/ssh-keys/:keyId
  app.patch('/tenants/:tenantId/ssh-keys/:keyId', async (request) => {
    const { tenantId, keyId } = request.params as { tenantId: string; keyId: string };
    const parsed = updateSshKeySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('MISSING_REQUIRED_FIELD', `Validation error: ${parsed.error.issues[0].message}`, 400);
    }
    const key = await service.updateSshKey(app.db, tenantId, keyId, parsed.data);
    return success(key);
  });

  // DELETE /api/v1/tenants/:tenantId/ssh-keys/:keyId
  app.delete('/tenants/:tenantId/ssh-keys/:keyId', async (request, reply) => {
    const { tenantId, keyId } = request.params as { tenantId: string; keyId: string };
    await service.deleteSshKey(app.db, tenantId, keyId);
    reply.status(204).send();
  });
}
