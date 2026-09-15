import type { FastifyInstance } from 'fastify';
import {
  podPruneRequestSchema,
  podPrunePolicySchema,
  DEFAULT_AUTO_PRUNE_DAYS,
} from '@insula/api-contracts';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { requireRole } from '../../middleware/auth.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { prunePods } from './service.js';
import { getAutoPruneDays, setAutoPruneDays } from './settings.js';

export async function podPruneRoutes(app: FastifyInstance): Promise<void> {
  function clients() {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    try {
      return createK8sClients(kubeconfigPath);
    } catch {
      throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not reachable', 503);
    }
  }

  /** Current retention. Read-only roles may see it. */
  app.get('/admin/pods/prune-policy', {
    onRequest: [requireRole('super_admin', 'admin', 'read_only')],
  }, async () => {
    return success({ autoPruneDays: await getAutoPruneDays(app.db) });
  });

  app.put('/admin/pods/prune-policy', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (req: { body: unknown; user?: { sub?: string } }) => {
    const parsed = podPrunePolicySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'invalid prune policy',
        400,
      );
    }
    await setAutoPruneDays(app.db, parsed.data.autoPruneDays);
    app.log.warn(
      { userId: req.user?.sub ?? 'unknown', autoPruneDays: parsed.data.autoPruneDays },
      'pod-prune: retention changed',
    );
    return success({ autoPruneDays: parsed.data.autoPruneDays });
  });

  /**
   * Sweep now. `olderThanDays` defaults to 0 — an operator pressing
   * "Prune Dead Pods" means now, not eventually.
   */
  app.post('/admin/pods/prune', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (req: { body: unknown; user?: { sub?: string } }) => {
    const parsed = podPruneRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'invalid prune request',
        400,
      );
    }
    const k8s = clients();
    const userId = req.user?.sub ?? 'unknown';
    app.log.warn({ userId, olderThanDays: parsed.data.olderThanDays ?? 0 }, 'pod-prune: manual sweep');
    try {
      const result = await prunePods({
        core: k8s.core,
        batch: k8s.batch,
        olderThanDays: parsed.data.olderThanDays ?? 0,
        log: app.log,
      });
      app.log.warn(
        { userId, scanned: result.scanned, pruned: result.pruned.length, skipped: result.skipped.length },
        'pod-prune: manual sweep complete',
      );
      return success(result);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      app.log.error({ err, userId }, 'pod-prune: manual sweep failed');
      throw new ApiError('POD_PRUNE_FAILED', 'Could not prune dead pods — see server logs', 500);
    }
  });
}

export { DEFAULT_AUTO_PRUNE_DAYS };
