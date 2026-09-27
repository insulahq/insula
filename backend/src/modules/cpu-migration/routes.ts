import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { buildCpuMigrationPreview } from './preview.js';

/**
 * The CPU migration dry run (ADR-062, R1).
 *
 * Read-only by construction — there is no write endpoint in this module. The
 * mechanism that would act on this report ships in R2; shipping the report
 * first is deliberate, because an operator has to be able to see what the
 * migration would do to their own cluster before anything is asked of them.
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
}
