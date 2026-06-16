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
import { createTenantSnapshotSchema, toSafeText } from '@insula/api-contracts';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { createSnapshot, listSnapshots, deleteSnapshot, restoreSnapshot, getRestoreOpStatus, waitForSnapshotReady } from './service.js';
import { start as startTask, finishByRef as finishTaskByRef } from '../tasks/service.js';

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

    // Enroll the create in the task center so it shows in the chip + a
    // detailed progress modal (admin) / progress modal on the Snapshots
    // page (tenant). A short-lived background watcher flips the task to
    // succeeded/failed when the Longhorn VolumeSnapshot finishes (~seconds);
    // the snapshot row + list reconcile remain the source of truth.
    const userId = request.user?.sub ?? null;
    if (userId) {
      const isTenantPanel = request.user?.panel === 'tenant';
      const target = isTenantPanel
        ? { type: 'route' as const, href: '/snapshots' }
        : { type: 'modal' as const, modal: 'snapshot-create', modalProps: { snapshotId: snap.id, tenantId } };
      await startTask(app.db, {
        kind: 'storage.snapshot',
        refId: snap.id,
        scope: isTenantPanel ? 'tenant' : 'admin',
        userId,
        tenantId,
        label: toSafeText(snap.label ? `Snapshot "${snap.label}"` : 'Snapshot'),
        target,
        progressText: toSafeText('Creating snapshot…'),
        details: { snapshotId: snap.id, tenantId },
      });
      const fdb = app.db;
      const fk8s = k8sFor();
      void (async () => {
        try {
          const ready = await waitForSnapshotReady({ db: fdb, k8s: fk8s }, tenantId, snap.id);
          await finishTaskByRef(fdb, 'storage.snapshot', snap.id, {
            status: 'succeeded',
            text: toSafeText('Snapshot ready'),
            detailsPatch: { sizeBytes: ready.sizeBytes },
          });
        } catch (err) {
          try {
            await finishTaskByRef(fdb, 'storage.snapshot', snap.id, {
              status: 'failed',
              error: err instanceof Error ? err.message : String(err),
            });
          } catch { /* best-effort — list reconcile still reflects the real state */ }
        }
      })();
    }

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

  // ── POST /api/v1/tenants/:tenantId/snapshots/:snapshotId/restore ────
  // DESTRUCTIVE: replaces the live volume with the snapshot's contents.
  app.post('/tenants/:tenantId/snapshots/:snapshotId/restore', {
    schema: { tags: ['TenantSnapshots'], summary: 'Restore the volume from a snapshot (destructive)', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { tenantId, snapshotId } = request.params as { tenantId: string; snapshotId: string };
    const result = await restoreSnapshot(
      { db: app.db, k8s: k8sFor() },
      tenantId,
      snapshotId,
      { triggeredByUserId: request.user?.sub ?? null },
    );
    reply.status(202);
    return success(result);
  });

  // ── GET /api/v1/tenants/:tenantId/snapshots/restore-status/:operationId ──
  app.get('/tenants/:tenantId/snapshots/restore-status/:operationId', {
    schema: { tags: ['TenantSnapshots'], summary: 'Poll a snapshot restore operation', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId, operationId } = request.params as { tenantId: string; operationId: string };
    const status = await getRestoreOpStatus({ db: app.db, k8s: k8sFor() }, tenantId, operationId);
    return success(status);
  });
}
