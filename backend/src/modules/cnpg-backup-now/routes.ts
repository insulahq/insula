import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  cnpgBackupNowRequestSchema,
  type CnpgBackupNowResponse,
} from '@insula/api-contracts';
import { createBackupNow, CnpgBackupNowError } from './service.js';

export async function cnpgBackupNowRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  // Backups are a destructive write surface (consumes storage, can
  // surface auth/connection problems on the upstream); super_admin
  // only — mirrors the postgres-barman-restore + cnpg-backup-now gate.
  app.addHook('onRequest', requireRole('super_admin'));

  // POST /api/v1/admin/cnpg-backup-now
  //
  // Operator-triggered "Backup Now" — creates a single Backup CR for the
  // named cluster. Returns immediately once Kubernetes accepts the CR;
  // the actual barman-cloud upload happens asynchronously in the cluster
  // control plane. Frontend polls the existing cnpg-backup-catalogue /
  // cnpg-backup-health endpoints to see the new backup appear.
  app.post('/admin/cnpg-backup-now', {
    schema: {
      tags: ['CnpgBackupNow'],
      summary: 'Create a CNPG Backup CR for on-demand base backup.',
      security: [{ bearerAuth: [] }],
    },
  }, async (request): Promise<{ data: CnpgBackupNowResponse }> => {
    const parsed = cnpgBackupNowRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.message, 400);
    }

    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);

    try {
      const result = await createBackupNow(
        k8s.custom,
        {
          namespace: parsed.data.namespace,
          clusterName: parsed.data.clusterName,
          description: parsed.data.description,
        },
        request.log,
      );
      return success(result);
    } catch (err) {
      if (err instanceof CnpgBackupNowError) {
        throw new ApiError('CNPG_BACKUP_NOW_FAILED', err.message, err.statusCode);
      }
      throw err;
    }
  });
}
