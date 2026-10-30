/**
 * HTTP routes for per-route OIDC sign-in.
 *
 *   GET    /api/v1/tenants/:tenantId/ingress-routes/:rid/auth
 *   PATCH  /api/v1/tenants/:tenantId/ingress-routes/:rid/auth
 *   DELETE /api/v1/tenants/:tenantId/ingress-routes/:rid/auth
 *   POST   /api/v1/tenants/:tenantId/ingress-routes/:rid/auth/test
 *
 * Auth: tenant_admin / super_admin / admin; a tenant token reaches its own
 * tenant only (requireTenantAccess), and every handler checks that the
 * route belongs to a domain of that tenant.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { ingressAuthConfigPatchSchema } from '@insula/api-contracts';
import { ingressRoutes, domains, tenants } from '../../db/schema.js';
import {
  getAuthConfig,
  upsertAuthConfig,
  deleteAuthConfig,
} from './service.js';
import { reconcileTenant, type ReconcileOutcome } from './reconciler.js';
import { canonicalIssuer, discoverIssuer } from './discovery.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import { reconcileIngress } from '../domains/k8s-ingress.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/**
 * Confirms the ingress route belongs to a domain owned by `tenantId`.
 * Throws 404 on mismatch rather than 403, to avoid leaking ownership.
 */
async function assertRouteBelongsToTenant(
  app: FastifyInstance,
  tenantId: string,
  routeId: string,
): Promise<{ namespace: string }> {
  const rows = await app.db
    .select({ ns: tenants.kubernetesNamespace })
    .from(ingressRoutes)
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .innerJoin(tenants, eq(tenants.id, domains.tenantId))
    .where(and(eq(ingressRoutes.id, routeId), eq(tenants.id, tenantId)));
  const ns = rows[0]?.ns;
  if (!ns) {
    throw new ApiError('NOT_FOUND', `Ingress route ${routeId} not found for tenant`, 404);
  }
  return { namespace: ns };
}

/** The sign-in service did not start: say why and what to do, in the panel. */
export function gateNotReady(outcome: ReconcileOutcome): ApiError {
  const code = 'OIDC_GATE_NOT_READY';
  const message = outcome.error ?? 'The sign-in service did not start.';
  return new ApiError(code, message, 409, {
    operatorError: {
      code,
      title: 'Sign-in is not working yet',
      detail: `Your settings are saved. ${message}`,
      remediation: [
        'Check the issuer URL with "Test issuer", and the client ID and secret at your identity provider.',
        'Register the redirect URI shown in the form at your identity provider.',
        'Until the sign-in service starts, the route answers with an error instead of the app.',
      ],
      retryable: true,
      diagnostics: outcome.proxyLog ? { proxyLog: outcome.proxyLog } : undefined,
    },
  });
}

/** Under the panels' proxy read timeout (60 s): the save itself is already done. */
export const GATE_WAIT_MS = 50_000;

export async function ingressAuthRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.PLATFORM_ENCRYPTION_KEY
    ?? process.env.PLATFORM_ENCRYPTION_KEY
    ?? '0'.repeat(64);

  // Resolved once; absent in vitest / local dev, where nothing is applied.
  let k8s: K8sClients | undefined;
  try {
    const kp = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kp);
  } catch (err) {
    app.log.warn({ err }, 'ingress-auth: k8s client unavailable — reconciler disabled');
  }

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'tenant_admin'));
  // The caller's own tenant only: a tenant token naming another tenant's id
  // in the path is refused before any handler runs.
  app.addHook('onRequest', requireTenantAccess());

  app.get('/tenants/:tenantId/ingress-routes/:rid/auth', async (request) => {
    const { tenantId, rid } = request.params as { tenantId: string; rid: string };
    await assertRouteBelongsToTenant(app, tenantId, rid);
    return success(await getAuthConfig(app.db, rid));
  });

  // PATCH — save (omitted fields keep their saved values), then bring the
  // gate and the route in line.
  app.patch('/tenants/:tenantId/ingress-routes/:rid/auth', async (request) => {
    const { tenantId, rid } = request.params as { tenantId: string; rid: string };
    const { namespace } = await assertRouteBelongsToTenant(app, tenantId, rid);
    const parsed = ingressAuthConfigPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const patch = parsed.data.issuerUrl
      ? { ...parsed.data, issuerUrl: await canonicalIssuer(parsed.data.issuerUrl) }
      : parsed.data;
    const saved = await upsertAuthConfig(app.db, { encryptionKey }, tenantId, rid, patch);
    if (k8s) {
      const deps = { db: app.db, k8s, encryptionKey };
      let outcome: ReconcileOutcome;
      if (saved.enabled) {
        // Gate first and Ready, then point the route at it. Should the gate
        // not start, the route is still switched: it fails closed (an error
        // page) rather than staying open while the form says "protected".
        outcome = await reconcileTenant(deps, tenantId, { wait: true, waitTimeoutMs: GATE_WAIT_MS });
        await reconcileIngress(app.db, k8s, tenantId, namespace);
      } else {
        // Off: open the route first, then remove the gate if it was the last.
        await reconcileIngress(app.db, k8s, tenantId, namespace);
        outcome = await reconcileTenant(deps, tenantId);
      }
      if (outcome.error) throw gateNotReady(outcome);
    }
    return success(await getAuthConfig(app.db, rid));
  });

  // DELETE — turn sign-in off for the route.
  app.delete('/tenants/:tenantId/ingress-routes/:rid/auth', async (request) => {
    const { tenantId, rid } = request.params as { tenantId: string; rid: string };
    const { namespace } = await assertRouteBelongsToTenant(app, tenantId, rid);
    await deleteAuthConfig(app.db, rid);
    if (k8s) {
      // reconcileIngress drops the route's gate and, with the last protected
      // route, the tenant's oauth2-proxy (reconcileSignInGate).
      await reconcileIngress(app.db, k8s, tenantId, namespace);
    }
    return success({ deleted: true });
  });

  // POST …/test — fetch the issuer's discovery document (guarded) and check it.
  app.post('/tenants/:tenantId/ingress-routes/:rid/auth/test', async (request) => {
    const { tenantId, rid } = request.params as { tenantId: string; rid: string };
    await assertRouteBelongsToTenant(app, tenantId, rid);
    const body = request.body as { issuerUrl?: unknown } | undefined;
    const issuerUrl = typeof body?.issuerUrl === 'string' ? body.issuerUrl : '';
    return success(await discoverIssuer(issuerUrl));
  });
}
