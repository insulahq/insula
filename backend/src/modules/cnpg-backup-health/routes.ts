import type { FastifyInstance } from 'fastify';
import * as k8s from '@kubernetes/client-node';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { readBackupHealth } from './service.js';

/**
 * GET /api/v1/admin/cnpg-backup-health
 *
 * Returns CNPG `Backup` CR health snapshot per cluster (mail-pg in
 * `mail` namespace + postgres in `platform` namespace by default —
 * see WATCHED_NAMESPACES in service.ts). Used by the admin panel to
 * surface backup failures + staleness without operators needing to
 * run `kubectl get backup.postgresql.cnpg.io` manually.
 *
 * Phase 2A.2 — closes the gap that let mail-pg-daily-20260505031500
 * fail unnoticed for 24h. The mistake that prompted this work: an
 * operator wiped mail-pg expecting CNPG to recreate clean, not
 * realising a fresh backup existed that would have restored every
 * mailbox's credentials.
 *
 * Read-only — every authenticated admin role can see the page so
 * operators don't get gated by permissions during incidents.
 */
export async function cnpgBackupHealthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.get(
    '/admin/cnpg-backup-health',
    {
      onRequest: [requireRole('super_admin', 'admin', 'read_only')],
    },
    async () => {
      const cfg = app.config as Record<string, unknown>;
      const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;

      const kc = new k8s.KubeConfig();
      if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
      else kc.loadFromCluster();
      const custom = kc.makeApiClient(k8s.CustomObjectsApi);

      const data = await readBackupHealth({ custom });
      return success(data);
    },
  );
}
