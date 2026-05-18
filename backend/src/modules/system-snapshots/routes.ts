import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  listSystemPvcSnapshots,
  listSnapshotsForVolume,
  takeSnapshot,
  deleteSnapshot,
  pruneVolumeSnapshots,
  revertSnapshot,
  listRecurringJobs,
  patchRecurringJob,
} from './service.js';

const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
function validateName(name: string, kind: string): void {
  if (!name || name.length > 253 || !NAME_RE.test(name)) {
    throw new ApiError('INVALID_FIELD_VALUE', `Invalid ${kind} name`, 400, { field: kind });
  }
}

export async function systemSnapshotsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/system-snapshots
  // Inventory of every PVC in a system namespace + its snapshot stats.
  app.get('/admin/system-snapshots', {
    schema: {
      tags: ['SystemSnapshots'],
      summary: 'List system PVCs with snapshot counters',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    const items = await listSystemPvcSnapshots(k8s, app.db);
    return success({ items });
  });

  // GET /api/v1/admin/system-snapshots/recurring-jobs
  app.get('/admin/system-snapshots/recurring-jobs', {
    schema: {
      tags: ['SystemSnapshots'],
      summary: 'List Longhorn RecurringJobs (frequency + retention policy)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    const jobs = await listRecurringJobs(k8s);
    return success({ jobs });
  });

  // PATCH /api/v1/admin/system-snapshots/recurring-jobs/:jobName
  app.patch('/admin/system-snapshots/recurring-jobs/:jobName', {
    schema: {
      tags: ['SystemSnapshots'],
      summary: 'Update a RecurringJob cron/retain',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['jobName'], properties: { jobName: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          cron: { type: 'string', minLength: 1, maxLength: 64 },
          retain: { type: 'integer', minimum: 1, maximum: 365 },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { jobName } = request.params as { jobName: string };
    validateName(jobName, 'jobName');
    const body = request.body as { cron?: string; retain?: number };
    if (body.cron === undefined && body.retain === undefined) {
      throw new ApiError('INVALID_INPUT', 'Provide at least one of cron / retain', 400);
    }
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    await patchRecurringJob(k8s, jobName, body);
    return success({ ok: true });
  });

  // GET /api/v1/admin/system-snapshots/:volumeName/snapshots
  app.get('/admin/system-snapshots/:volumeName/snapshots', {
    schema: {
      tags: ['SystemSnapshots'],
      summary: 'List Longhorn snapshots for a system volume',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['volumeName'], properties: { volumeName: { type: 'string' } } },
    },
  }, async (request) => {
    const { volumeName } = request.params as { volumeName: string };
    validateName(volumeName, 'volumeName');
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    const snapshots = await listSnapshotsForVolume(k8s, volumeName);
    return success({ snapshots });
  });

  // POST /api/v1/admin/system-snapshots/:volumeName/snapshots
  app.post('/admin/system-snapshots/:volumeName/snapshots', {
    schema: {
      tags: ['SystemSnapshots'],
      summary: 'Take a manual snapshot of a system volume',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['volumeName'], properties: { volumeName: { type: 'string' } } },
      body: {
        type: 'object',
        properties: { label: { type: 'string', maxLength: 63 } },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { volumeName } = request.params as { volumeName: string };
    validateName(volumeName, 'volumeName');
    const body = (request.body ?? {}) as { label?: string };
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    const result = await takeSnapshot(k8s, volumeName, body.label);
    return success(result);
  });

  // DELETE /api/v1/admin/system-snapshots/:volumeName/snapshots/:snapshotName
  app.delete('/admin/system-snapshots/:volumeName/snapshots/:snapshotName', {
    schema: {
      tags: ['SystemSnapshots'],
      summary: 'Delete one snapshot of a system volume',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['volumeName', 'snapshotName'],
        properties: { volumeName: { type: 'string' }, snapshotName: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { volumeName, snapshotName } = request.params as { volumeName: string; snapshotName: string };
    validateName(volumeName, 'volumeName');
    validateName(snapshotName, 'snapshotName');
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    try {
      await deleteSnapshot(k8s, volumeName, snapshotName);
      return success({ ok: true });
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 404) {
        throw new ApiError('SNAPSHOT_NOT_FOUND', (err as Error).message, 404, { field: 'snapshotName' });
      }
      if (code === 409) {
        throw new ApiError('SNAPSHOT_VOLUME_MISMATCH', (err as Error).message, 409, { field: 'snapshotName' });
      }
      throw err;
    }
  });

  // DELETE /api/v1/admin/system-snapshots/:volumeName/snapshots
  // Prune all snapshots for one volume. Defaults to keepNewest=1 so the
  // operator never accidentally drops to zero recovery points.
  app.delete('/admin/system-snapshots/:volumeName/snapshots', {
    schema: {
      tags: ['SystemSnapshots'],
      summary: 'Prune all snapshots for one volume (keep newest N)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['volumeName'], properties: { volumeName: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: { keepNewest: { type: 'integer', minimum: 0, maximum: 100 } },
      },
    },
  }, async (request) => {
    const { volumeName } = request.params as { volumeName: string };
    const { keepNewest } = (request.query ?? {}) as { keepNewest?: number };
    validateName(volumeName, 'volumeName');
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    const result = await pruneVolumeSnapshots(k8s, volumeName, keepNewest ?? 1);
    return success(result);
  });

  // POST /api/v1/admin/system-snapshots/:volumeName/snapshots/:snapshotName/restore
  // Body: { pvcNamespace, pvcName }. Full lifecycle: scale consumer→0,
  // wait detach, snapshotRevert via Longhorn manager REST, scale back,
  // wait reattach. Sync (~2-5 min wall-clock).
  app.post('/admin/system-snapshots/:volumeName/snapshots/:snapshotName/restore', {
    schema: {
      tags: ['SystemSnapshots'],
      summary: 'Restore a system volume to a snapshot (in-place revert)',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['volumeName', 'snapshotName'],
        properties: { volumeName: { type: 'string' }, snapshotName: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['pvcNamespace', 'pvcName'],
        properties: {
          pvcNamespace: { type: 'string', minLength: 1, maxLength: 253 },
          pvcName: { type: 'string', minLength: 1, maxLength: 253 },
        },
      },
    },
  }, async (request) => {
    const { volumeName, snapshotName } = request.params as { volumeName: string; snapshotName: string };
    const { pvcNamespace, pvcName } = request.body as { pvcNamespace: string; pvcName: string };
    validateName(volumeName, 'volumeName');
    validateName(snapshotName, 'snapshotName');
    validateName(pvcNamespace, 'pvcNamespace');
    validateName(pvcName, 'pvcName');
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    try {
      const result = await revertSnapshot(k8s, pvcNamespace, pvcName, volumeName, snapshotName);
      return success(result);
    } catch (err) {
      const code = (err as { code?: number }).code;
      const stepsTrace = (err as { steps?: ReadonlyArray<{ step: string; ok: boolean; detail?: string }> }).steps ?? [];
      if (code === 404) throw new ApiError('SNAPSHOT_NOT_FOUND', (err as Error).message, 404);
      if (code === 409) throw new ApiError('SNAPSHOT_NOT_RESTORABLE', (err as Error).message, 409, { steps: stepsTrace });
      if (code === 422) throw new ApiError('CONSUMER_UNRESOLVED', (err as Error).message, 422, { steps: stepsTrace });
      throw new ApiError('RESTORE_FAILED', (err as Error).message, 500, { steps: stepsTrace });
    }
  });
}
