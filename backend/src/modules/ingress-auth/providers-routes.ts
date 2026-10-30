/**
 * HTTP routes for per-tenant OIDC provider CRUD.
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
 * Changing a provider changes the sign-in of every route using it: PATCH
 * re-applies the tenant's gate and waits for it, so a rotated secret or a
 * corrected issuer takes effect now and a bad one is reported now.
 * Delete answers 409 PROVIDER_IN_USE while routes still use the provider.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { oidcProviderInputSchema, oidcProviderUpdateSchema } from '@insula/api-contracts';
import {
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
} from './providers-service.js';
import { canonicalIssuer } from './discovery.js';
import { reconcileTenant } from './reconciler.js';
import { gateNotReady, GATE_WAIT_MS } from './routes.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

export async function oidcProvidersRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey =
    app.config?.PLATFORM_ENCRYPTION_KEY ?? process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64);

  let k8s: K8sClients | undefined;
  try {
    const kp = (app.config as Record<string, unknown> | undefined)?.KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kp);
  } catch (err) {
    app.log.warn({ err }, 'oidc-providers: k8s client unavailable — provider changes are not applied');
  }

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'tenant_admin'));
  // The caller's own tenant only: a tenant token naming another tenant's id
  // in the path is refused before any handler runs.
  app.addHook('onRequest', requireTenantAccess());

  app.get('/tenants/:tenantId/oidc-providers', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    return success(await listProviders(app.db, tenantId));
  });

  app.post('/tenants/:tenantId/oidc-providers', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = oidcProviderInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const input = { ...parsed.data, issuerUrl: await canonicalIssuer(parsed.data.issuerUrl) };
    const provider = await createProvider(app.db, { encryptionKey }, tenantId, input);
    reply.status(201).send(success(provider));
  });

  app.get('/tenants/:tenantId/oidc-providers/:id', async (request) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const provider = await getProvider(app.db, tenantId, id);
    if (!provider) {
      throw new ApiError('NOT_FOUND', `Provider ${id} not found`, 404);
    }
    return success(provider);
  });

  // PATCH — partial: an omitted field is kept (the update schema has no defaults).
  app.patch('/tenants/:tenantId/oidc-providers/:id', async (request) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const parsed = oidcProviderUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const input = parsed.data.issuerUrl
      ? { ...parsed.data, issuerUrl: await canonicalIssuer(parsed.data.issuerUrl) }
      : parsed.data;
    const provider = await updateProvider(app.db, { encryptionKey }, tenantId, id, input);
    if (k8s && provider.consumerCount > 0) {
      const outcome = await reconcileTenant({ db: app.db, k8s, encryptionKey }, tenantId, { wait: true, waitTimeoutMs: GATE_WAIT_MS });
      if (outcome.error) throw gateNotReady(outcome);
    }
    return success(provider);
  });

  app.delete('/tenants/:tenantId/oidc-providers/:id', async (request) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    await deleteProvider(app.db, tenantId, id);
    return success({ deleted: true });
  });
}
