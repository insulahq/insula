import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import crypto from 'node:crypto';
import { renamePlatformDomainSchema } from '@insula/api-contracts';
import { renamePlatformDomain } from './service.js';
import { getPlatformApex } from '../system-settings/platform-domain.js';
import { auditLogs } from '../../db/schema.js';

export async function platformDomainRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/admin/platform-domain — the current platform apex + the
  // platform hostnames derived from it. admin/super_admin readable.
  app.get('/admin/platform-domain', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async () => {
    const apex = await getPlatformApex(app.db);
    return success({
      platformDomain: apex,
      hostnames: apex
        ? { admin: `admin.${apex}`, tenant: `tenant.${apex}`, webmail: `webmail.${apex}`, mail: `mail.${apex}` }
        : null,
    });
  });

  // POST /api/v1/admin/platform-domain/rename — turnkey apex rename.
  // super_admin only: it moves every reconciler-driven platform hostname +
  // cert. ingress_base_domain (tenant CNAME target) is NOT touched.
  app.post('/admin/platform-domain/rename', {
    onRequest: [requireRole('super_admin')],
  }, async (request) => {
    const parsed = renamePlatformDomainSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    }

    const result = await renamePlatformDomain(
      {
        db: app.db,
        config: app.config as Record<string, unknown>,
        log: {
          info: (obj: unknown, msg?: string) => app.log.info(obj as object, msg),
          warn: (obj: unknown, msg?: string) => app.log.warn(obj as object, msg),
        },
      },
      parsed.data.newApex,
    );

    // Forensic audit — a platform-apex rename is a high-impact action.
    try {
      await app.db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorId: (request.user as { sub?: string } | undefined)?.sub ?? 'system',
        actorType: 'user',
        actionType: 'platform_settings.platform_domain_rename',
        resourceType: 'platform_settings',
        resourceId: 'platform_domain',
        changes: {
          previousApex: result.previousApex,
          newApex: result.newApex,
          reconciled: result.reconciled,
        } as unknown as Record<string, unknown>,
      });
    } catch (err) {
      app.log.error({ err, newApex: result.newApex }, 'platform-domain rename: audit_logs insert failed');
    }

    return success(result);
  });
}
