import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { purgeImagesInputSchema } from '@insula/api-contracts';
import { getStorageOverview, getImageInventory, purgeUnusedImages } from './service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { runExclusiveOrBusy } from '../../shared/exclusive-run.js';

export async function storageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/admin/storage/overview — system + tenant storage usage
  app.get('/admin/storage/overview', {
    preHandler: [requireRole('admin', 'super_admin', 'read_only')],
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const overview = await getStorageOverview(app.db, k8s, kubeconfigPath);
    return success(overview);
  });

  // GET /api/v1/admin/storage/images — image inventory with in-use and protected flags
  app.get('/admin/storage/images', {
    preHandler: [requireRole('admin', 'super_admin', 'read_only')],
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const inventory = await getImageInventory(k8s);
    return success(inventory);
  });

  // POST /api/v1/admin/storage/purge — purge unused, non-protected images
  app.post('/admin/storage/purge', {
    preHandler: [requireRole('admin', 'super_admin')],
  }, async (request) => {
    const parsed = purgeImagesInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('INVALID_INPUT', 'Invalid purge input', 400, { errors: parsed.error.issues });
    }
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);

    // A real purge takes the daily sweep's run lock, so the two never fan out
    // their per-node pods together. A dry run removes nothing and may overlap.
    const exclusively = <T>(run: () => Promise<T>): Promise<T> => (parsed.data.dryRun
      ? run()
      : runExclusiveOrBusy(app.db, 'daily-image-prune', 'An image purge', run, { log: app.log }));

    // Wrap the purge in a chip task so the operator can see it running
    // (typically 30-90s on a busy cluster). dryRun mode also gets a
    // task — quick win, low overhead, and surfaces the run in audit.
    const userId = (request.user as { sub?: string } | undefined)?.sub ?? null;
    if (userId) {
      const { tracked } = await import('../tasks/service.js');
      const { toSafeText } = await import('@insula/api-contracts');
      const result = await exclusively(() => tracked(
        app.db,
        {
          kind: 'cache.purge',
          scope: 'admin',
          userId,
          label: toSafeText(`Cache purge${parsed.data.dryRun ? ' (dry-run)' : ''}`),
          // The image inventory and the purge button live on Monitoring → Storage.
          target: { type: 'route', href: '/monitoring/storage' },
          details: { dryRun: parsed.data.dryRun },
        },
        () => purgeUnusedImages(k8s, parsed.data.dryRun),
      ));
      return success(result);
    }
    const result = await exclusively(() => purgeUnusedImages(k8s, parsed.data.dryRun));
    return success(result);
  });
}
