import type { FastifyInstance } from 'fastify';
import { regions } from '../../db/schema.js';
import { createCacheMiddleware } from '../../middleware/cache.js';
import { success } from '../../shared/response.js';
import { authenticate } from '../../middleware/auth.js';

export async function regionRoutes(app: FastifyInstance) {
  // M5: authenticate — /regions is only consumed by the admin-panel
  // CreateTenantModal (a post-login flow). It was previously anonymous.
  // Also select ONLY the UI-facing columns: the full row carries
  // `kubernetes_api_endpoint`, an internal infrastructure coordinate the
  // frontend never uses and that must not be disclosed to any caller.
  app.get('/regions', {
    onRequest: [authenticate],
    preHandler: createCacheMiddleware(300_000),
  }, async () => {
    const rows = await app.db
      .select({
        id: regions.id,
        code: regions.code,
        name: regions.name,
        provider: regions.provider,
        status: regions.status,
        createdAt: regions.createdAt,
      })
      .from(regions);
    return success(rows);
  });
}
