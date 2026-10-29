/**
 * HTTP routes for OpenZiti provider CRUD.
 *
 *   GET    /api/v1/tenants/:tenantId/ziti-providers
 *   POST   /api/v1/tenants/:tenantId/ziti-providers
 *   PATCH  /api/v1/tenants/:tenantId/ziti-providers/:pid
 *   DELETE /api/v1/tenants/:tenantId/ziti-providers/:pid
 *   POST   /api/v1/tenants/:tenantId/ziti-providers/:pid/test
 *
 * Auth: tenant_admin / super_admin / admin; a tenant token reaches its own
 * tenant only (requireTenantAccess), and handlers scope provider rows by
 * that id.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { zitiProviderInputSchema } from '@insula/api-contracts';
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

export async function zitiProvidersRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.PLATFORM_ENCRYPTION_KEY
    ?? process.env.PLATFORM_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'tenant_admin'));
  // The caller's own tenant only: a tenant token naming another tenant's id
  // in the path is refused before any handler runs.
  app.addHook('onRequest', requireTenantAccess());

  app.get('/tenants/:tenantId/ziti-providers', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const rows = await listProviders(app.db, tenantId);
    return success(rows);
  });

  app.post('/tenants/:tenantId/ziti-providers', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = zitiProviderInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const created = await createProvider(app.db, encryptionKey, tenantId, parsed.data);
    return success(created);
  });

  app.patch('/tenants/:tenantId/ziti-providers/:pid', async (request) => {
    const { tenantId, pid } = request.params as { tenantId: string; pid: string };
    const parsed = zitiProviderInputSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const updated = await updateProvider(app.db, encryptionKey, tenantId, pid, parsed.data);
    return success(updated);
  });

  app.delete('/tenants/:tenantId/ziti-providers/:pid', async (request) => {
    const { tenantId, pid } = request.params as { tenantId: string; pid: string };
    await deleteProvider(app.db, tenantId, pid);
    return success({ deleted: true });
  });

  // Probes the controller's CA bundle endpoint to validate reachability.
  // Doesn't persist or modify anything.
  app.post('/tenants/:tenantId/ziti-providers/:pid/test', async (request) => {
    const { tenantId: _cid, pid: _pid } = request.params as { tenantId: string; pid: string };
    // For v1, the test just probes the configured controller URL —
    // resolving the provider row first is unnecessary because the
    // probe target comes from the request body. This avoids leaking
    // enrollment JWTs into the test path.
    const body = request.body as { controllerUrl?: string } | null;
    const url = body?.controllerUrl;
    if (!url) {
      throw new ApiError('VALIDATION_ERROR', 'controllerUrl required', 400);
    }
    try {
      const probe = `${url.replace(/\/+$/, '')}/.well-known/est/cacerts`;
      const res = await fetch(probe, { method: 'GET', signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        return success({
          ok: false,
          controllerReachable: true,
          caBundleBytes: null,
          error: `controller responded ${res.status}`,
        });
      }
      const text = await res.text();
      return success({
        ok: true,
        controllerReachable: true,
        caBundleBytes: text.length,
        error: null,
      });
    } catch (err) {
      return success({
        ok: false,
        controllerReachable: false,
        caBundleBytes: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
