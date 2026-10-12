import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { runExclusiveOrBusy } from '../../shared/exclusive-run.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { checkTenantNamespaceIntegrity, sweepFleetIntegrity } from './service.js';

export async function namespaceIntegrityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/tenants/:id/namespace-integrity
  // Read-only audit. UI shows findings; the operator triggers repair via POST.
  app.get('/admin/tenants/:id/namespace-integrity', {
    schema: {
      tags: ['NamespaceIntegrity'],
      summary: 'Audit a tenant namespace for missing platform resources',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      throw new ApiError('INVALID_FIELD_VALUE', 'Invalid tenant id', 400, { field: 'id' });
    }
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const report = await checkTenantNamespaceIntegrity(app.db, k8s, id, false);
    return success(report);
  });

  // POST /api/v1/admin/tenants/:id/namespace-integrity/repair
  // Re-runs the inspect + repair against k8s and writes a notification
  // row for every admin user when something was repaired or errored.
  app.post('/admin/tenants/:id/namespace-integrity/repair', {
    schema: {
      tags: ['NamespaceIntegrity'],
      summary: 'Run the namespace-integrity reconciler for a single tenant',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      throw new ApiError('INVALID_FIELD_VALUE', 'Invalid tenant id', 400, { field: 'id' });
    }
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    // The sweep's own repair, for one tenant — under the sweep's run lock, so
    // the two never repair the same namespace at once (the one that loses
    // reports a failure for what the other one repaired).
    const report = await runExclusiveOrBusy(app.db, 'namespace-integrity', 'A namespace integrity sweep',
      () => checkTenantNamespaceIntegrity(app.db, k8s, id, true), { log: app.log });
    return success(report);
  });

  // POST /api/v1/admin/namespace-integrity/sweep
  // Fleet-wide repair pass (the same code that the cron sweep runs).
  app.post('/admin/namespace-integrity/sweep', {
    schema: {
      tags: ['NamespaceIntegrity'],
      summary: 'Run the namespace-integrity reconciler across all provisioned tenants',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    // Under the sweep's run lock: two sweeps at once race on each repair, and
    // the one that loses reports a failure for what the other one repaired.
    const result = await runExclusiveOrBusy(app.db, 'namespace-integrity', 'A namespace integrity sweep',
      () => sweepFleetIntegrity(app.db, k8s), { log: app.log });
    return success(result);
  });
}
