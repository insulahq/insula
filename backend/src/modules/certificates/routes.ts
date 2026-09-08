/**
 * Tenant- and admin-facing TLS certificate endpoints.
 *
 * Both panels hit the same two routes; `requireTenantAccess` is what
 * separates them (an admin passes for any tenant, a tenant user only for
 * their own). The reissue POST is Bearer-only like every other mutating
 * endpoint — no cookie fallback.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireTenantRoleByMethod, requireTenantAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { requestCertificateReissue, clearStuckValidation } from './reissue.js';
import { getDomainTlsStatus } from './tls-status.js';

function getK8s() {
  try {
    return createK8sClients(process.env.KUBECONFIG_PATH);
  } catch {
    return null;
  }
}

export async function certificateRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/tenants/:tenantId/domains/:domainId/tls
  app.get('/tenants/:tenantId/domains/:domainId/tls', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['TLS Certificates'],
      summary: 'Certificate state for a domain, straight from cert-manager',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    return success(await getDomainTlsStatus(app.db, getK8s(), domainId, tenantId));
  });

  // POST /api/v1/tenants/:tenantId/domains/:domainId/tls/reissue
  /**
   * Break-glass: clear a stuck ACME validation.
   *
   * Deliberately NOT behind the reissue cooldown. That cooldown exists because
   * a reissue orders a NEW certificate and Let's Encrypt caps duplicates at
   * five per week — burning them locks the domain out for seven days. This
   * endpoint orders nothing: it deletes a local Challenge object whose slot is
   * blocking cert-manager's scheduler, so the EXISTING order can finally run.
   * Gating it on the cooldown would leave an operator staring at a disabled
   * button for an hour with no way to unstick a certificate, which is exactly
   * the hole this fills.
   */
  app.post('/tenants/:tenantId/domains/:domainId/tls/clear-stuck-validation', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['TLS Certificates'],
      summary: 'Clear a wedged ACME challenge so issuance can restart',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const result = await clearStuckValidation(app.db, getK8s(), { tenantId, domainId });
    return success(result);
  });

  app.post('/tenants/:tenantId/domains/:domainId/tls/reissue', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['TLS Certificates'],
      summary: 'Request a new certificate for a domain now',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const user = request.user as { sub: string; role?: string } | undefined;

    const result = await requestCertificateReissue(app.db, getK8s(), {
      domainId,
      tenantId,
      userId: user?.sub ?? '',
      // Scope decides which task list the progress lands in. An admin
      // acting on a tenant's domain watches it from the admin panel.
      scope: user?.role && user.role !== 'tenant_admin' && user.role !== 'tenant_user' ? 'admin' : 'tenant',
    });

    reply.status(202);
    return success(result);
  });
}
