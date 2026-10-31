/**
 * HTTP routes for zrok provider CRUD.
 *
 *   GET    /api/v1/tenants/:tenantId/zrok-providers
 *   POST   /api/v1/tenants/:tenantId/zrok-providers
 *   PATCH  /api/v1/tenants/:tenantId/zrok-providers/:pid
 *   DELETE /api/v1/tenants/:tenantId/zrok-providers/:pid
 *
 * Auth: tenant_admin / super_admin / admin; a tenant token reaches its own
 * tenant only (requireTenantAccess), and handlers scope rows by that id.
 *
 * There is no "test connection" route: it fetched any URL the caller sent and
 * returned the response body, so a tenant admin could read internal HTTP
 * services through platform-api (a `?` at the end of the URL turned the
 * appended `/api/v1/version` into a query string). No panel used it. The zrok
 * agent in the tenant's own namespace is what talks to the controller.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { zrokProviderInputSchema } from '@insula/api-contracts';
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
} from './service.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

export async function zrokProvidersRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.PLATFORM_ENCRYPTION_KEY
    ?? process.env.PLATFORM_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'tenant_admin'));
  // The caller's own tenant only: a tenant token naming another tenant's id
  // in the path is refused before any handler runs.
  app.addHook('onRequest', requireTenantAccess());

  app.get('/tenants/:tenantId/zrok-providers', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const rows = await listProviders(app.db, tenantId);
    return success(rows);
  });

  app.post('/tenants/:tenantId/zrok-providers', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = zrokProviderInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const created = await createProvider(app.db, encryptionKey, tenantId, parsed.data);
    return success(created);
  });

  app.patch('/tenants/:tenantId/zrok-providers/:pid', async (request) => {
    const { tenantId, pid } = request.params as { tenantId: string; pid: string };
    const parsed = zrokProviderInputSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const updated = await updateProvider(app.db, encryptionKey, tenantId, pid, parsed.data);
    return success(updated);
  });

  app.delete('/tenants/:tenantId/zrok-providers/:pid', async (request) => {
    const { tenantId, pid } = request.params as { tenantId: string; pid: string };
    await deleteProvider(app.db, tenantId, pid);
    return success({ deleted: true });
  });
}
