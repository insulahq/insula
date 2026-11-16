/**
 * WAF trusted IPs of a tenant route.
 *
 *   GET    /tenants/:tenantId/routes/:routeId/waf-trusted-ips
 *   POST   /tenants/:tenantId/routes/:routeId/waf-trusted-ips      { value, note? }
 *   DELETE /tenants/:tenantId/routes/:routeId/waf-trusted-ips/:id
 *
 * A change re-renders the WAF's dynamic rules inline (the modsec-crs pods
 * then roll one at a time); the 5-minute reconcile covers a missed run.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createWafTrustedIpRequestSchema, WAF_TRUSTED_IPS_PER_ROUTE_MAX } from '@insula/api-contracts';
import { authenticate, requireTenantAccess, requireTenantRoleByMethod } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { RUN_WAIT_MS } from '../../shared/exclusive-run.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { runWafExclusionReconcile } from '../waf-rule-exclusions/scheduler.js';
import { createTrustedIpForRoute, deleteTrustedIpForRoute, listTrustedIpsForRoute } from './service.js';

interface Params {
  readonly tenantId: string;
  readonly routeId: string;
  readonly id?: string;
}

const actorOf = (req: FastifyRequest): string => {
  const user = (req as unknown as { user?: { sub?: string; email?: string } }).user;
  return user?.email ?? user?.sub ?? 'unknown';
};

export async function wafTrustedIpRoutes(app: FastifyInstance): Promise<void> {
  const reconcile = async (): Promise<void> => {
    let k8s: ReturnType<typeof createK8sClients> | undefined;
    try {
      k8s = createK8sClients((app.config as Record<string, unknown> | undefined)?.KUBECONFIG_PATH as string | undefined);
    } catch {
      return;
    }
    try {
      const run = await runWafExclusionReconcile(app.db, { core: k8s.core, apps: k8s.apps }, app.log, { waitMs: RUN_WAIT_MS });
      if (!run.ran) app.log.warn({}, 'waf-trusted-ips: a reconcile was still running after the wait; the next tick applies this change');
    } catch (err) {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'waf-trusted-ips: inline reconcile failed (scheduler will retry)');
    }
  };

  const doc = (summary: string) => ({ tags: ['Ingress Route WAF'], summary, security: [{ bearerAuth: [] }] });

  app.get('/tenants/:tenantId/routes/:routeId/waf-trusted-ips', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: doc('List the WAF trusted IPs of a route'),
  }, async (request) => {
    const { tenantId, routeId } = request.params as Params;
    const trustedIps = await listTrustedIpsForRoute(app.db, tenantId, routeId);
    return success({ trustedIps, max: WAF_TRUSTED_IPS_PER_ROUTE_MAX });
  });

  app.post('/tenants/:tenantId/routes/:routeId/waf-trusted-ips', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: doc('Trust an address or network on this route: inspected and logged, never blocked'),
  }, async (request) => {
    const { tenantId, routeId } = request.params as Params;
    const parsed = createWafTrustedIpRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'INVALID_BODY',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        400,
      );
    }
    const actor = actorOf(request);
    const created = await createTrustedIpForRoute(app.db, tenantId, routeId, parsed.data, actor);
    app.log.warn({ actor, tenantId, routeId, value: created.value }, 'waf-trusted-ips: created');
    await reconcile();
    return success(created);
  });

  app.delete('/tenants/:tenantId/routes/:routeId/waf-trusted-ips/:id', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: doc('Stop trusting an address or network on this route'),
  }, async (request) => {
    const { tenantId, routeId, id } = request.params as Params;
    await deleteTrustedIpForRoute(app.db, tenantId, routeId, id ?? '');
    app.log.warn({ actor: actorOf(request), tenantId, routeId, id }, 'waf-trusted-ips: deleted');
    await reconcile();
    return success({ deleted: true });
  });
}
