import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { tenants, domains, backupJobs } from '../../db/schema.js';
import { createCacheMiddleware } from '../../middleware/cache.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { buildAdminSummary, buildAdminLive } from './admin-service.js';

/**
 * Two endpoints, not twenty-three.
 *
 * The dashboard needs ~23 distinct facts. Fetched one endpoint at a time that
 * is 23 requests on open and 46 a minute while polling, against a per-user
 * limit of 100 — two browser tabs and an operator throttles themselves. Eleven
 * of those reads also leave the API for the kube API, so the cost scales with
 * how many people are watching rather than with how fast anything changes.
 *
 *   /admin/dashboard/summary   database only. Cheap; cached 30s.
 *   /admin/dashboard/live      kube API and friends. Cached 120s.
 *
 * Both are cached server-side, so N operators cost what one does. The cache
 * middleware keys on METHOD:url and is NOT per-user — correct here because
 * every field is platform-wide, and worth stating because the same middleware
 * on a tenant-scoped route would serve one tenant's data to another.
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('admin', 'super_admin', 'read_only'));

  app.get('/admin/dashboard/summary', {
    preHandler: createCacheMiddleware(30_000),
    schema: { tags: ['Dashboard'], summary: 'Admin dashboard — database-backed sections' },
  }, async () => ({ data: await buildAdminSummary(app.db, app.log) }));

  app.get('/admin/dashboard/live', {
    preHandler: createCacheMiddleware(120_000),
    schema: { tags: ['Dashboard'], summary: 'Admin dashboard — cluster-backed sections' },
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    return { data: await buildAdminLive(app.db, k8s, app.log) };
  });

  // Retained: the old four-counter payload. Removing it would break any
  // client still asking for it, and it costs one cached query.
  app.get('/admin/dashboard', { preHandler: createCacheMiddleware(30_000) }, async () => {
    const [tenantStats] = await app.db
      .select({
        total_tenants: sql<number>`count(*)`,
        active_tenants: sql<number>`sum(case when ${tenants.status} = 'active' then 1 else 0 end)`,
      })
      .from(tenants);
    const [domainStats] = await app.db
      .select({ total_domains: sql<number>`count(*)` })
      .from(domains);
    const [backupStats] = await app.db
      .select({ total_backups: sql<number>`count(*)` })
      .from(backupJobs);

    return {
      data: {
        total_tenants: Number(tenantStats.total_tenants),
        active_tenants: Number(tenantStats.active_tenants ?? 0),
        total_domains: Number(domainStats.total_domains),
        total_backups: Number(backupStats.total_backups),
        platform_version: process.env.PLATFORM_VERSION ?? '0.1.0',
      },
    };
  });
}
