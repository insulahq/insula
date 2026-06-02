/**
 * WAL-archive health admin surface.
 *   GET  /admin/wal-archive-health              — breaker state + live snapshot
 *   POST /admin/wal-archive-health/reset-breaker — re-enable archiving (super_admin)
 *
 * The reset is the operator's "I fixed the backup target, turn archiving back
 * on" action: it clears the circuit-breaker so the postgres-objectstore
 * reconciler re-attaches the barman plugin on its next tick.
 */
import type { FastifyInstance } from 'fastify';
import { authenticate, requirePanel, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { readCircuitBreaker, resetCircuitBreaker } from './breaker.js';
import { readWalArchiveHealth } from './service.js';
import { assessWalArchive } from './health.js';

export async function walArchiveHealthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));

  app.get('/admin/wal-archive-health', {
    schema: {
      tags: ['WalArchiveHealth'],
      summary: 'WAL-archive circuit-breaker state + live archiving/pressure snapshot.',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const breaker = await readCircuitBreaker(app.db);
    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    const snapshot = await readWalArchiveHealth({ db: app.db, custom: k8s.custom, log: request.log });
    const assessment = snapshot ? assessWalArchive(snapshot) : null;
    return success({ breaker, snapshot, assessment });
  });

  // Re-enabling backups is a meaningful state change → super_admin only.
  app.post('/admin/wal-archive-health/reset-breaker', {
    onRequest: requireRole('super_admin'),
    schema: {
      tags: ['WalArchiveHealth'],
      summary: 'Clear the WAL-archive circuit-breaker (re-enable archiving after fixing the target).',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const before = await readCircuitBreaker(app.db);
    await resetCircuitBreaker(app.db);
    request.log.warn({ wasTripped: before.tripped, previousReason: before.reason },
      'wal-archive-health: circuit-breaker RESET by operator — archiving re-enables on the next reconcile');
    return success({ reset: true, wasTripped: before.tripped });
  });
}
