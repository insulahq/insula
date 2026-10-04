import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { fixDnsApexDriftSchema } from '@insula/api-contracts';
import * as service from './service.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Route ("apex") DNS drift endpoints.
 *
 * GET  /admin/dns/apex-drift        latest stored report (cheap — no provider calls)
 * POST /admin/dns/apex-drift/scan   run a scan now (never changes DNS)
 * POST /admin/dns/apex-drift/fix    repair selected domains (adds missing, removes stale) → taskId
 *
 * The read and the scan are deliberately separate: the banner polls the stored
 * report and must not trigger provider traffic on every page load.
 */
export async function dnsApexDriftRoutes(app: FastifyInstance): Promise<void> {
  // The live node list is what attributes addresses to servers and reflects a
  // per-server ingress change at once; without a kubeconfig (local dev, tests)
  // the scan falls back to the stored inventory.
  const k8s = (): K8sClients | null => {
    try {
      return createK8sClients((app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined);
    } catch {
      return null;
    }
  };

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  app.get('/admin/dns/apex-drift', async () => {
    return success(await service.getLastReport(app.db));
  });

  app.post('/admin/dns/apex-drift/scan', async () => {
    return success(await service.scanApexDrift(app.db, { trigger: 'manual', k8s: k8s() }));
  });

  app.post('/admin/dns/apex-drift/fix', async (request) => {
    const parsed = fixDnsApexDriftSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid request body',
        400,
      );
    }
    const userId = request.user?.sub;
    if (!userId) {
      throw new ApiError('UNAUTHORIZED', 'Authenticated user required', 401);
    }
    const result = await service.startApexDriftFix(app.db, userId, {
      domainIds: parsed.data.domainIds,
      all: parsed.data.all,
    }, k8s());
    return success(result);
  });
}
