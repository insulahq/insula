import type { FastifyInstance } from 'fastify';
import { regions } from '../../db/schema.js';
import { createCacheMiddleware } from '../../middleware/cache.js';
import { success } from '../../shared/response.js';

export async function regionRoutes(app: FastifyInstance) {
  // Public reference-data endpoint (like `/plans`) — used by the signup /
  // create-tenant flow. M5: select ONLY the UI-facing columns. The full row
  // carries `kubernetes_api_endpoint`, an internal infrastructure coordinate
  // the frontend never uses and that must NOT be disclosed to an anonymous
  // caller. Region names/codes/providers are non-sensitive reference data, so
  // the endpoint stays public (consistent with `/plans`); dropping the column
  // is the actual fix for the "anonymous users learn the API server address"
  // finding. Mutating region routes remain admin-gated.
  app.get('/regions', { preHandler: createCacheMiddleware(300_000) }, async () => {
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
