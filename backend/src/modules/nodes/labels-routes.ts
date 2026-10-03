import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { loadNodeLabels } from './labels.js';

/**
 * GET /api/v1/admin/node-labels — what every admin-panel surface calls each
 * node (its alias, else its Kubernetes name). A route of its own because the
 * node list is super_admin/admin only, and support, billing and read-only
 * staff read node names on Monitoring and tenant pages too.
 */
export async function nodeLabelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'billing', 'support', 'read_only'));

  app.get('/admin/node-labels', {
    schema: { tags: ['Nodes'], summary: 'Display labels for cluster nodes', security: [{ bearerAuth: [] }] },
  }, async () => success((await loadNodeLabels(app.db)).rows));
}
