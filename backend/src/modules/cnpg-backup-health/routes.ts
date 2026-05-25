import type { FastifyInstance } from 'fastify';
import * as k8s from '@kubernetes/client-node';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { readBackupHealth } from './service.js';

/**
 * GET /api/v1/admin/cnpg-backup-health
 *
 * Returns CNPG `Backup` CR health snapshot per cluster (system-db in
 * `platform` namespace — see WATCHED_NAMESPACES in service.ts). Used
 * by the admin panel to surface backup failures + staleness without
 * operators needing to run `kubectl get backup.postgresql.cnpg.io`
 * manually.
 *
 * Phase 2A.2 (origin) — closes the gap that let a silent
 * ScheduledBackup failure (spec.backup temporarily unset during a
 * recovery exercise) go unnoticed for 24h. The prompting incident
 * was on the mail-pg cluster, since deleted; the lesson generalises.
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
      const core = kc.makeApiClient(k8s.CoreV1Api);

      // Pass core so the catalogue enrichment can probe the object
      // store for `cnpg_operator_blind` detection.
      const data = await readBackupHealth({ custom, core });
      return success(data);
    },
  );
}
