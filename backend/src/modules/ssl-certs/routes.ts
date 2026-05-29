import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { uploadSslCertSchema } from '@insula/api-contracts';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function sslCertRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.PLATFORM_ENCRYPTION_KEY ?? process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires PLATFORM_ENCRYPTION_KEY env var */;

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireTenantAccess());

  // POST /api/v1/tenants/:tenantId/domains/:domainId/ssl-cert
  app.post('/tenants/:tenantId/domains/:domainId/ssl-cert', {
    onRequest: [requireRole('super_admin', 'admin', 'tenant_admin')],
  }, async (request, reply) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };

    const parsed = uploadSslCertSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const cert = await service.uploadCert(app.db, tenantId, domainId, parsed.data, encryptionKey);
    reply.status(201).send(success(cert));
  });

  // GET /api/v1/tenants/:tenantId/domains/:domainId/ssl-cert
  app.get('/tenants/:tenantId/domains/:domainId/ssl-cert', {
    onRequest: [requireRole('super_admin', 'admin', 'support', 'tenant_admin')],
  }, async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };

    const cert = await service.getCert(app.db, tenantId, domainId);
    return success(cert);
  });

  // DELETE /api/v1/tenants/:tenantId/domains/:domainId/ssl-cert
  app.delete('/tenants/:tenantId/domains/:domainId/ssl-cert', {
    onRequest: [requireRole('super_admin', 'admin', 'tenant_admin')],
  }, async (request, reply) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };

    await service.deleteCert(app.db, tenantId, domainId);
    reply.status(204).send();
  });
}
