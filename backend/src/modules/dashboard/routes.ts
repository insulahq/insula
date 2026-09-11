import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { tenants, domains, backupJobs } from '../../db/schema.js';
import { createCacheMiddleware } from '../../middleware/cache.js';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('admin', 'super_admin', 'read_only'));

  // GET /api/v1/admin/dashboard — aggregated platform metrics
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

    // Off-site tenant BUNDLES (`backup_jobs`) — the only thing that actually
    // backs a tenant up. This used to count the `backups` table, which the
    // retired per-resource backup API was the only writer of: it held zero
    // rows on every cluster, so this metric reported 0 backups on a platform
    // holding hundreds of bundles. Retired with that table 2026-09-11.
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
