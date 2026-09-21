import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { hostingPlans } from '../../db/schema.js';
import { getTenantById } from '../tenants/service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { buildTenantSummary, buildTenantLive } from './tenant-service.js';

/**
 * The tenant panel's two endpoints.
 *
 * Deliberately NOT wrapped in the shared response cache: that middleware keys
 * on METHOD:url only, so two tenants hitting their own dashboard would collide
 * on one entry and be served each other's data. The admin endpoints can use it
 * because every field there is platform-wide; these cannot. Caching per tenant
 * belongs behind the tenant id, and the payload is cheap enough to build.
 */
export async function tenantDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.get('/tenants/:tenantId/dashboard/summary', {
    preHandler: [
      requireRole('admin', 'super_admin', 'read_only', 'tenant_admin', 'tenant_user'),
      requireTenantAccess(),
    ],
    schema: { tags: ['Dashboard'], summary: 'Tenant dashboard — database-backed sections' },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    return { data: await buildTenantSummary(app.db, tenantId, app.log) };
  });

  app.get('/tenants/:tenantId/dashboard/live', {
    preHandler: [
      requireRole('admin', 'super_admin', 'read_only', 'tenant_admin', 'tenant_user'),
      requireTenantAccess(),
    ],
    schema: { tags: ['Dashboard'], summary: 'Tenant dashboard — live resource sections' },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const tenant = await getTenantById(app.db, tenantId);
    const [plan] = await app.db.select().from(hostingPlans).where(eq(hostingPlans.id, tenant.planId));
    const planLimits = {
      cpuLimit: Number(tenant.cpuLimitOverride ?? plan?.cpuLimit ?? 2),
      memoryLimitGi: Number(tenant.memoryLimitOverride ?? plan?.memoryLimit ?? 4),
      storageLimitGi: Number(tenant.storageLimitOverride ?? plan?.storageLimit ?? 50),
    };
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    return {
      data: await buildTenantLive(
        app.db, k8s, tenantId, tenant.kubernetesNamespace, planLimits, app.log,
      ),
    };
  });
}
