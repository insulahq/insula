/**
 * Tenant on-server volume-snapshot routes (tenant panel + admin panel).
 *
 * Mounted under `/api/v1`. The `/tenants/:tenantId/...` shape + the
 * requireTenantAccess gate means a tenant token reaches only its own tenant,
 * while operator roles can manage any tenant's snapshots — same model as the
 * file-manager routes the Snapshots feature sits beside.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireTenantRoleByMethod, requireTenantAccess } from '../../middleware/auth.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import { createTenantSnapshotSchema } from '@insula/api-contracts';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { createSnapshot, listSnapshots, deleteSnapshot } from './service.js';

export async function tenantSnapshotsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  const k8sFor = (): K8sClients =>
    createK8sClients((app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined);

  // ── GET /api/v1/tenants/:tenantId/snapshots ────────────────────────
  app.get('/tenants/:tenantId/snapshots', {
    schema: { tags: ['TenantSnapshots'], summary: 'List a tenant\'s on-server volume snapshots', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const result = await listSnapshots({ db: app.db, k8s: k8sFor() }, tenantId);
    return success(result);
  });

  // ── POST /api/v1/tenants/:tenantId/snapshots ───────────────────────
  app.post('/tenants/:tenantId/snapshots', {
    schema: { tags: ['TenantSnapshots'], summary: 'Create an on-server volume snapshot', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = createTenantSnapshotSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
    }
    const snap = await createSnapshot(
      { db: app.db, k8s: k8sFor() },
      tenantId,
      { label: parsed.data.label ?? null, triggeredByUserId: request.user?.sub ?? null },
    );
    reply.status(201);
    return success(snap);
  });

  // ── DELETE /api/v1/tenants/:tenantId/snapshots/:snapshotId ──────────
  app.delete('/tenants/:tenantId/snapshots/:snapshotId', {
    schema: { tags: ['TenantSnapshots'], summary: 'Delete an on-server volume snapshot', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { tenantId, snapshotId } = request.params as { tenantId: string; snapshotId: string };
    await deleteSnapshot({ db: app.db, k8s: k8sFor() }, tenantId, snapshotId);
    reply.status(204).send();
  });
}
