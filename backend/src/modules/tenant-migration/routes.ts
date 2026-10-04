import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { migrateTenantToWorker } from './service.js';

export async function tenantMigrationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // POST /api/v1/admin/tenants/:id/migrate-to-worker
  //
  // Body: { node_name: string }
  //
  // Re-pins the tenant to a new worker. A tenant running on another
  // node is stopped, moved and started there by a background storage
  // operation (`moveOperationId` in the response); otherwise its
  // running Deployments restart in place. Its data follows: Longhorn
  // copies it to the new node (tenant-placement/relocate.ts).
  app.post('/admin/tenants/:id/migrate-to-worker', {
    schema: {
      tags: ['TenantMigration'],
      summary: 'Re-pin a tenant to a different worker node',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { node_name?: unknown };
    if (typeof body.node_name !== 'string' || body.node_name.trim() === '') {
      throw new ApiError('INVALID_FIELD_VALUE', 'node_name is required', 400, { field: 'node_name' });
    }

    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const result = await migrateTenantToWorker(app.db, k8s, id, {
      nodeName: body.node_name,
      triggeredByUserId: ((request.user as { id?: string } | undefined)?.id) ?? null,
    });
    return success(result);
  });
}
