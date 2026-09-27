import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { buildCpuMigrationPreview } from './preview.js';
import { parseBody } from '../../shared/validate-body.js';
import { cpuMigrationApplySchema } from '@insula/api-contracts';
import {
  startTenantCpuMigration, revertTenantCpuMigration, stopTenantCpuMigration,
} from './runner.js';

/**
 * The CPU tier migration (ADR-062).
 *
 * The dry run (R1) is the only GET and stays read-only. The write verbs (R2)
 * are all PER TENANT and there is deliberately NO fleet-wide "migrate
 * everything": a single button across an unknown cluster is the flag day this
 * ADR exists to avoid. The operator moves one tenant, watches it, moves the
 * next — and each one makes the next safer, because every migration hands CPU
 * back.
 */
export async function cpuMigrationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/admin/cpu-migration/preview
  app.get('/admin/cpu-migration/preview', {
    onRequest: [requireRole('super_admin', 'admin')],
    schema: {
      tags: ['admin'],
      summary: 'Dry-run the CPU tier migration (ADR-062) — reports only, changes nothing',
    },
  }, async () => {
    const k8s = createK8sClients(
      (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined,
    );
    const preview = await buildCpuMigrationPreview(app.db, k8s, app.log);
    return success(preview);
  });

  // POST /api/v1/admin/cpu-migration/tenants/:tenantId/apply
  //
  // Runs inline rather than detaching: the whole design is paced and gated,
  // an operator watching one tenant is the intended use, and a detached
  // runner would need its own crash-recovery story for no benefit here.
  app.post('/admin/cpu-migration/tenants/:tenantId/apply', {
    onRequest: [requireRole('super_admin')],
    schema: { tags: ['admin'], summary: 'Migrate ONE tenant to tiered CPU scheduling (ADR-062)' },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    // Parsed AND used — the acknowledgement is what lets a flagged tenant
    // through, so discarding it made the whole review advisory.
    const { acknowledgeBlockers } = parseBody(cpuMigrationApplySchema, request.body ?? {});
    const userId = (request.user as { sub?: string } | undefined)?.sub ?? 'system';
    const k8s = createK8sClients(
      (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined,
    );
    const { taskId, outcome } = await startTenantCpuMigration(
      app.db, k8s, tenantId, userId, acknowledgeBlockers,
    );
    return success({
      taskId,
      tenantId,
      status: outcome.status,
      step: outcome.status === 'completed' ? null : outcome.afterStep,
      freedMillis: outcome.status === 'completed' ? outcome.freedMillis : null,
      reason: outcome.status === 'failed' ? outcome.reason : null,
      progressPct: outcome.status === 'completed' ? 100 : null,
    });
  });

  // POST …/revert — put the tenant back exactly as it was.
  app.post('/admin/cpu-migration/tenants/:tenantId/revert', {
    onRequest: [requireRole('super_admin')],
    schema: { tags: ['admin'], summary: 'Revert ONE tenant to legacy CPU scheduling' },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const k8s = createK8sClients(
      (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined,
    );
    const outcome = await revertTenantCpuMigration(app.db, k8s, tenantId);
    return success({
      tenantId,
      status: outcome.status,
      restored: outcome.restored,
      unrestorable: outcome.status === 'completed' ? outcome.unrestorable : 0,
      reason: outcome.status === 'failed' ? outcome.reason : null,
    });
  });

  // POST …/stop — the stop button. Writes a flag the runner polls, so it
  // works across replicas: the request may land on a pod that is not the one
  // looping.
  app.post('/admin/cpu-migration/tenants/:tenantId/stop', {
    onRequest: [requireRole('super_admin')],
    schema: { tags: ['admin'], summary: 'Ask a running CPU migration to stop after the current step' },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const userId = (request.user as { sub?: string } | undefined)?.sub ?? 'system';
    await stopTenantCpuMigration(app.db, tenantId, userId);
    return success({ tenantId, stopRequested: true });
  });
}
