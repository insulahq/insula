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

// How old a cached sample may be and still count as "live" for the tenant-facing
// endpoint. The panel polls every 60s, so anything under that reads as current;
// 15s exists only to coalesce concurrent viewers (and the per-pod caches of
// several API replicas) into one collection instead of one per request.
//
// Deliberately NOT stale-while-revalidate any more: that returned the OLD value
// and refreshed behind it, so an operator watching the page had to reload twice
// to see a change and the numbers always trailed reality by a refresh.
const LIVE_MAX_AGE_MS = 15 * 1000;

/**
 * Bulk-refresh bounds for the admin tenant list. Each collection makes
 * several K8s API calls (metrics API, pod list, quota read) plus one
 * VictoriaMetrics query, so a fan-out across every tenant at once would
 * hit the API server harder than the staggered hourly scheduler ever does.
 * Cap the concurrency, and cap how many tenants one request will refresh —
 * the rest keep their cached sample and are picked up on the next poll,
 * oldest-first, so nothing starves.
 */
const BULK_REFRESH_CONCURRENCY = 8;
const BULK_REFRESH_MAX = 25;

/** Run `fn` over `items` with at most `limit` in flight. Never rejects —
 *  `collectSafe` already swallows per-tenant failures. */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

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

    // Serve the cache only while it is still within the live window; otherwise
    // collect synchronously so the caller always gets current numbers.
    const cached = await getCachedMetrics(id);
    if (cached && Date.now() - new Date(cached.lastUpdatedAt).getTime() <= LIVE_MAX_AGE_MS) {
      return success(cached);
    }

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

  // GET /api/v1/admin/tenants/resource-metrics — bulk metrics for the tenant list
  //
  // This used to return `getAllCachedMetrics` verbatim: no age check, no
  // fallback collection. The cache is a per-POD in-memory LRU (shared/redis.ts
  // — Redis was removed in M14) populated only by the hourly metrics-scheduler,
  // which runs independently on every replica with no leader election. So the
  // admin tenant list showed numbers up to an hour old, different numbers
  // depending on which replica served the request, and nothing at all for a
  // tenant whose entry that pod had never collected.
  //
  // Now: serve cache within the live window, collect the rest concurrently.
  // Collection is bounded and best-effort — one unreachable tenant namespace
  // must not blank the whole list.
  app.get('/admin/tenants/resource-metrics', {
    preHandler: [requireRole('admin', 'super_admin', 'read_only')],
  }, async () => {
    const allTenants = await app.db.select({ id: tenants.id }).from(tenants);
    const tenantIds = allTenants.map(c => c.id);
    const metricsMap = await getAllCachedMetrics(tenantIds);

    const ageOf = (id: string): number => {
      const m = metricsMap[id];
      return m ? Date.now() - new Date(m.lastUpdatedAt).getTime() : Number.POSITIVE_INFINITY;
    };
    const stale = tenantIds
      .filter(id => ageOf(id) > LIVE_MAX_AGE_MS)
      .sort((a, b) => ageOf(b) - ageOf(a)); // oldest (and never-collected) first

    if (stale.length > 0) {
      const batch = stale.slice(0, BULK_REFRESH_MAX);
      if (stale.length > batch.length) {
        // Never truncate silently — a capped list still reads as "everything
        // is current" to whoever is looking at it.
        app.log.info(
          { stale: stale.length, refreshed: batch.length },
          '[metrics] bulk refresh capped; remaining tenants keep their cached sample this round',
        );
      }
      await runBounded(batch, BULK_REFRESH_CONCURRENCY, id => collectSafe(app, id));
      // collectSafe writes through the cache; re-read so this response carries
      // the values it just collected rather than the ones it started with.
      Object.assign(metricsMap, await getAllCachedMetrics(batch));
    }

    return success(metricsMap);
  });
}
