import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  createBarmanRestore,
  getBarmanRestoreStatus,
  deleteBarmanRestore,
  promoteRestoredCluster,
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

  // POST /api/v1/admin/postgres-barman-restore/:namespace/:newClusterName/promote
  //
  // Phase 3.1 (2026-05-23): destructive cutover. Take a Longhorn
  // snapshot of the restored cluster's primary PVC, then invoke the
  // existing PITR orchestrator against the SOURCE cluster name with
  // that snapshot. After PITR success the Job pod additionally deletes
  // the side-by-side Cluster CR.
  //
  // Body MUST carry `confirmSourceClusterName` matching `sourceClusterName`
  // exactly — server-side type-to-confirm gate (the wizard's input is
  // UX, this is the security boundary).
  //
  // Returns 202 — same shape as POST /admin/postgres-restore so the
  // wizard can reuse the PitrProgressModal via the task-center chip.
  app.post('/admin/postgres-barman-restore/:namespace/:newClusterName/promote', {
    schema: {
      tags: ['PostgresBarmanRestore'],
      summary: 'Destructive cutover: swap a side-by-side restored cluster into the source cluster name. Type-to-confirm required in body.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['namespace', 'newClusterName'],
        properties: {
          namespace: { type: 'string', minLength: 1, maxLength: 50 },
          newClusterName: { type: 'string', minLength: 1, maxLength: 50 },
        },
      },
      body: {
        type: 'object',
        required: ['sourceClusterName', 'confirmSourceClusterName'],
        properties: {
          sourceClusterName: { type: 'string', minLength: 1, maxLength: 50 },
          confirmSourceClusterName: { type: 'string', minLength: 1, maxLength: 50 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const p = request.params as { namespace: string; newClusterName: string };
    const body = request.body as { sourceClusterName: string; confirmSourceClusterName: string };
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    const actor = (request as unknown as { user?: { sub?: string } }).user;
    let result;
    try {
      result = await promoteRestoredCluster(
        { k8s, db: app.db },
        {
          namespace: p.namespace,
          restoredClusterName: p.newClusterName,
          sourceClusterName: body.sourceClusterName,
          confirmSourceClusterName: body.confirmSourceClusterName,
          actorUserId: actor?.sub ?? null,
        },
        request.log,
      );
    } catch (err) { rethrowApi(err); }

    // Register task-center chip so the operator can re-open the
    // PitrProgressModal from the chip after closing the wizard.
    if (actor?.sub) {
      try {
        const { start: startTask } = await import('../tasks/service.js');
        const { toSafeText } = await import('@k8s-hosting/api-contracts');
        await startTask(app.db, {
          kind: 'postgres.barman-promote',
          refId: result!.jobName,
          scope: 'admin',
          userId: actor.sub,
          label: toSafeText(`Barman promote (${result!.namespace}/${result!.restoredClusterName} → ${result!.sourceClusterName})`),
          // Reuse the PITR progress modal — same step timeline applies.
          target: {
            type: 'modal' as const,
            modal: 'pitr-progress',
            modalProps: {
              jobName: result!.jobName,
              clusterNamespace: result!.namespace,
              clusterName: result!.sourceClusterName,
            },
          },
          details: {
            sourceClusterName: result!.sourceClusterName,
            restoredClusterName: result!.restoredClusterName,
            snapshotName: result!.snapshotName,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.warn(`[barman-promote] task tracker enroll failed: ${msg}`);
      }
    }

    reply.code(202);
    return success({
      status: 'promoting',
      restoredClusterName: result!.restoredClusterName,
      sourceClusterName: result!.sourceClusterName,
      namespace: result!.namespace,
      snapshotName: result!.snapshotName,
      jobName: result!.jobName,
      jobNamespace: result!.jobNamespace,
      pollUrl: '/api/v1/admin/postgres-restore/status',
      message: `Barman promote: ${result!.namespace}/${result!.restoredClusterName} → ${result!.sourceClusterName}. Job ${result!.jobName} created; orchestration runs ~5-10 min in a dedicated pod. Source data WILL BE REPLACED. Poll /admin/postgres-restore/status for progress.`,
    });
  });
}
