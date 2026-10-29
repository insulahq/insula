/**
 * HTTP routes for per-client OIDC provider CRUD.
 *
 *   GET    /api/v1/tenants/:tenantId/oidc-providers
 *   POST   /api/v1/tenants/:tenantId/oidc-providers
 *   GET    /api/v1/tenants/:tenantId/oidc-providers/:id
 *   PATCH  /api/v1/tenants/:tenantId/oidc-providers/:id
 *   DELETE /api/v1/tenants/:tenantId/oidc-providers/:id
 *
 * Auth: tenant_admin / super_admin / admin; a tenant token reaches its own
 * tenant only (requireTenantAccess), and every handler scopes by that id.
 *
 * Delete returns 409 with consumer count when ingresses still
 * reference the provider (FK RESTRICT at the DB level).
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { oidcProviderInputSchema } from '@insula/api-contracts';
import {
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
} from './providers-service.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

export async function oidcProvidersRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey =
    app.config?.PLATFORM_ENCRYPTION_KEY ?? process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64);

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'tenant_admin'));
  // The caller's own tenant only: a tenant token naming another tenant's id
  // in the path is refused before any handler runs.
  app.addHook('onRequest', requireTenantAccess());

  // GET — list all providers for a tenant.
  app.get('/tenants/:tenantId/oidc-providers', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const rows = await listProviders(app.db, tenantId);
    return success(rows);
  });

  // POST — create a new provider.
  app.post('/tenants/:tenantId/oidc-providers', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = oidcProviderInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const provider = await createProvider(app.db, { encryptionKey }, tenantId, parsed.data);
    reply.status(201).send(success(provider));
  });

  // GET — single provider.
  app.get('/tenants/:tenantId/oidc-providers/:id', async (request) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const provider = await getProvider(app.db, tenantId, id);
    if (!provider) {
      throw new ApiError('NOT_FOUND', `Provider ${id} not found`, 404);
    }
    return success(provider);
  });

  // PATCH — partial update. tenantSecret optional.
  app.patch('/tenants/:tenantId/oidc-providers/:id', async (request) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const parsed = oidcProviderInputSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const provider = await updateProvider(app.db, { encryptionKey }, tenantId, id, parsed.data);
    return success(provider);
  });

  // DELETE — 409 when in use.
  app.delete('/tenants/:tenantId/oidc-providers/:id', async (request) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    await deleteProvider(app.db, tenantId, id);
    return success({ deleted: true });
  });
}
