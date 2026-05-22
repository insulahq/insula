import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { metricsQuerySchema } from './schema.js';
import * as service from './service.js';
import { getCachedMetrics, getAllCachedMetrics, collectTenantMetrics } from './resource-metrics.js';
import { getTenantById } from '../tenants/service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenants, hostingPlans } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes — trigger background refresh

/**
 * Resolve effective plan limits for a tenant, applying per-tenant overrides.
 */
async function resolvePlanLimits(
  db: Parameters<typeof service.getMetrics>[0],
  tenant: Awaited<ReturnType<typeof getTenantById>>,
): Promise<{ cpuLimit: number; memoryLimitGi: number; storageLimitGi: number }> {
  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, tenant.planId));

  return {
    cpuLimit: Number(tenant.cpuLimitOverride ?? plan?.cpuLimit ?? 2),
    memoryLimitGi: Number(tenant.memoryLimitOverride ?? plan?.memoryLimit ?? 4),
    storageLimitGi: Number(tenant.storageLimitOverride ?? plan?.storageLimit ?? 50),
  };
}

/**
 * Collect metrics for a tenant, swallowing errors (for background refresh).
 */
async function collectSafe(
  app: FastifyInstance,
  tenantId: string,
): Promise<void> {
  try {
    const tenant = await getTenantById(app.db, tenantId);
    if (tenant.provisioningStatus !== 'provisioned') return;

    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const planLimits = await resolvePlanLimits(app.db, tenant);
    await collectTenantMetrics(app.db, k8s, tenantId, tenant.kubernetesNamespace, planLimits);
  } catch (err) {
    console.warn(`[metrics] Background refresh failed for ${tenantId}:`, err instanceof Error ? err.message : String(err));
  }
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // ─── Historical metrics (existing) ──────────────────────────────────────────

  // GET /api/v1/tenants/:id/metrics
  app.get('/tenants/:id/metrics', {
    preHandler: [requireRole('admin', 'super_admin', 'read_only')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    const parsed = metricsQuerySchema.parse(query);
    const metrics = await service.getMetrics(app.db, id, parsed);
    return success(metrics);
  });

  // ─── Real-time resource metrics (Redis-cached with stale-while-revalidate) ──

  // GET /api/v1/tenants/:id/resource-metrics — get cached, auto-refresh if stale
  app.get('/tenants/:id/resource-metrics', {
    preHandler: [requireRole('admin', 'super_admin', 'read_only', 'tenant_admin', 'tenant_user'), requireTenantAccess()],
  }, async (request) => {
    const { id } = request.params as { id: string };

    // Try cache first
    const cached = await getCachedMetrics(id);
    if (cached) {
      // Stale-while-revalidate: return cached data immediately,
      // trigger background refresh if older than threshold
      const age = Date.now() - new Date(cached.lastUpdatedAt).getTime();
      if (age > STALE_THRESHOLD_MS) {
        // Fire-and-forget — don't await
        collectSafe(app, id).catch(() => {});
      }
      return success(cached);
    }

    // Cache miss — collect on-demand (blocking)
    const tenant = await getTenantById(app.db, id);
    if (tenant.provisioningStatus !== 'provisioned') {
      throw new ApiError('TENANT_NOT_PROVISIONED', 'Tenant is not provisioned yet', 409);
    }

    let k8s: ReturnType<typeof createK8sClients>;
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      k8s = createK8sClients(kubeconfigPath);
    } catch {
      throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not reachable', 503);
    }

    const planLimits = await resolvePlanLimits(app.db, tenant);
    const metrics = await collectTenantMetrics(app.db, k8s, id, tenant.kubernetesNamespace, planLimits);
    return success(metrics);
  });

  // POST /api/v1/tenants/:id/resource-metrics/refresh — force immediate refresh
  app.post('/tenants/:id/resource-metrics/refresh', {
    preHandler: [requireRole('admin', 'super_admin', 'tenant_admin'), requireTenantAccess()],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const tenant = await getTenantById(app.db, id);

    if (tenant.provisioningStatus !== 'provisioned') {
      throw new ApiError('TENANT_NOT_PROVISIONED', 'Tenant is not provisioned yet', 409);
    }

    let k8s: ReturnType<typeof createK8sClients>;
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      k8s = createK8sClients(kubeconfigPath);
    } catch {
      throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not reachable', 503);
    }

    const planLimits = await resolvePlanLimits(app.db, tenant);
    const metrics = await collectTenantMetrics(app.db, k8s, id, tenant.kubernetesNamespace, planLimits);
    return success(metrics);
  });

  // GET /api/v1/admin/tenants/resource-metrics — bulk get metrics for all tenants
  app.get('/admin/tenants/resource-metrics', {
    preHandler: [requireRole('admin', 'super_admin', 'read_only')],
  }, async () => {
    const allTenants = await app.db.select({ id: tenants.id }).from(tenants);
    const tenantIds = allTenants.map(c => c.id);
    const metricsMap = await getAllCachedMetrics(tenantIds);
    return success(metricsMap);
  });
}
