import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  createBarmanRestore,
  getBarmanRestoreStatus,
  deleteBarmanRestore,
  BarmanRestoreError,
} from './service.js';

function rethrowApi(err: unknown): never {
  if (err instanceof BarmanRestoreError) {
    throw new ApiError('BARMAN_RESTORE_FAILED', err.message, err.code);
  }
  throw err;
}

export async function postgresBarmanRestoreRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  // PHASE 3 (2026-05-22): Side-by-side restore is non-destructive
  // (creates entirely new resources next to source). Promote is the
  // destructive sibling — gated to super_admin only and lives in a
  // separate route file (Phase 3.1). For now both routes here require
  // super_admin OR admin.
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // POST /api/v1/admin/postgres-barman-restore
  // Body: { namespace, sourceClusterName, newClusterName, recoveryTargetTime?, instances? }
  //
  // Creates a NEW Cluster CR with bootstrap.recovery from source's
  // barman-cloud ObjectStore. Returns 202 immediately; restore runs in
  // the CNPG operator's reconcile loop. Poll /status for progress.
  app.post('/admin/postgres-barman-restore', {
    schema: {
      tags: ['PostgresBarmanRestore'],
      summary: 'Side-by-side restore from a barman-cloud archive. Creates a NEW Cluster CR; source is untouched.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['namespace', 'sourceClusterName', 'newClusterName'],
        properties: {
          namespace: { type: 'string', minLength: 1, maxLength: 50 },
          sourceClusterName: { type: 'string', minLength: 1, maxLength: 50 },
          newClusterName: { type: 'string', minLength: 1, maxLength: 50 },
          recoveryTargetTime: { type: 'string', format: 'date-time' },
          instances: { type: 'integer', minimum: 1, maximum: 5 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      namespace: string;
      sourceClusterName: string;
      newClusterName: string;
      recoveryTargetTime?: string;
      instances?: number;
    };
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    let result;
    try {
      result = await createBarmanRestore(k8s.custom, {
        namespace: body.namespace,
        sourceClusterName: body.sourceClusterName,
        newClusterName: body.newClusterName,
        recoveryTargetTime: body.recoveryTargetTime ?? null,
        instances: body.instances,
      }, request.log);
    } catch (err) { rethrowApi(err); }
    reply.code(202);
    return success({
      status: 'side-by-side-restoring',
      ...result!,
      pollUrl: `/api/v1/admin/postgres-barman-restore/${result!.namespace}/${result!.newClusterName}/status`,
      message: `Side-by-side restore Cluster ${result!.namespace}/${result!.newClusterName} created from ${result!.objectStoreName}. Source cluster is untouched. Poll status for progress; first instance typically reaches Ready in 2-10 minutes depending on archive size + WAL replay.`,
    });
  });

  // GET /api/v1/admin/postgres-barman-restore/:namespace/:newClusterName/status
  app.get('/admin/postgres-barman-restore/:namespace/:newClusterName/status', {
    schema: {
      tags: ['PostgresBarmanRestore'],
      summary: 'Status of a side-by-side restore. Returns CNPG cluster phase + conditions.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['namespace', 'newClusterName'],
        properties: {
          namespace: { type: 'string', minLength: 1, maxLength: 50 },
          newClusterName: { type: 'string', minLength: 1, maxLength: 50 },
        },
      },
    },
  }, async (request) => {
    const p = request.params as { namespace: string; newClusterName: string };
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    try {
      const data = await getBarmanRestoreStatus(k8s.custom, p.namespace, p.newClusterName);
      return success(data);
    } catch (err) { rethrowApi(err); }
  });

  // DELETE /api/v1/admin/postgres-barman-restore/:namespace/:newClusterName
  //
  // Cleanup the side-by-side cluster after the operator has finished
  // verifying / dumping data. Idempotent (404 returns deleted=false).
  // Guards: refuses to delete clusters not labelled with our
  // managed-by tag — only operates on its own creations.
  app.delete('/admin/postgres-barman-restore/:namespace/:newClusterName', {
    schema: {
      tags: ['PostgresBarmanRestore'],
      summary: 'Delete a side-by-side restore Cluster CR (only if managed by this module).',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['namespace', 'newClusterName'],
        properties: {
          namespace: { type: 'string', minLength: 1, maxLength: 50 },
          newClusterName: { type: 'string', minLength: 1, maxLength: 50 },
        },
      },
    },
  }, async (request) => {
    const p = request.params as { namespace: string; newClusterName: string };
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    try {
      const r = await deleteBarmanRestore(k8s.custom, p.namespace, p.newClusterName, request.log);
      return success({ ...r, namespace: p.namespace, newClusterName: p.newClusterName });
    } catch (err) { rethrowApi(err); }
  });
}
