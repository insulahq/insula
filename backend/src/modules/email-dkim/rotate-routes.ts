/**
 * Manual DKIM rotation route.
 *
 * Endpoint:
 *   POST /api/v1/tenants/:tenantId/email-domains/:domainId/dkim/rotate
 *
 * Auth: tenant_admin (the owner of the tenant) OR platform admin.
 * Audit: each rotation logs to the existing audit_log via the
 * standard request lifecycle hook.
 *
 * Idempotency: NOT idempotent — re-running creates a NEW DkimSignature
 * row each time. The tenant-panel UI requires a confirmation modal
 * to prevent accidental fan-out.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import crypto from 'node:crypto';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { emailDomains, domains, auditLogs } from '../../db/schema.js';
import { rotateDkimKey, DkimRotationError } from './rotate.js';

const paramsSchema = z.object({
  tenantId: z.string().uuid(),
  domainId: z.string().uuid(),
});

interface RouteParams {
  readonly tenantId: string;
  readonly domainId: string;
}

export async function emailDkimRotateRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: RouteParams }>(
    '/tenants/:tenantId/email-domains/:domainId/dkim/rotate',
    {
      onRequest: [authenticate, requireRole('super_admin', 'admin', 'tenant_admin', 'support')],
    },
    async (request) => {
      // Defence-in-depth: validate UUID format on path params before
      // hitting the DB, even though Drizzle parameterises queries.
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw new ApiError(
          'INVALID_PARAMS',
          parsedParams.error.issues.map((i) => i.message).join('; '),
          400,
        );
      }
      const { tenantId, domainId } = parsedParams.data;

      // Authorization: tenant_admin must own the tenant. The
      // requireRole middleware lets all four through; we narrow with
      // an explicit check here so tenant_admin from tenant A can't
      // rotate keys for tenant B.
      const userTenantId = (request.user as { tenantId?: string } | undefined)?.tenantId;
      const userRole = (request.user as { role?: string } | undefined)?.role;
      if (userRole === 'tenant_admin' && userTenantId !== tenantId) {
        throw new ApiError(
          'FORBIDDEN',
          'You can only rotate DKIM keys for your own tenant',
          403,
        );
      }

      // Verify the email-domain belongs to this tenant (via its parent
      // domain). Otherwise an admin could mis-target a domain by ID.
      const [row] = await app.db
        .select({
          edId: emailDomains.id,
          domainName: domains.domainName,
          parentTenantId: domains.tenantId,
        })
        .from(emailDomains)
        .innerJoin(domains, eq(domains.id, emailDomains.domainId))
        .where(and(eq(emailDomains.id, domainId), eq(domains.tenantId, tenantId)));

      if (!row) {
        throw new ApiError(
          'EMAIL_DOMAIN_NOT_FOUND',
          `Email domain '${domainId}' not found for tenant '${tenantId}'`,
          404,
        );
      }

      const encryptionKey = process.env.ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new ApiError(
          'INTERNAL_SERVER_ERROR',
          'ENCRYPTION_KEY env var is not set',
          500,
        );
      }

      try {
        const result = await rotateDkimKey(app.db, domainId, encryptionKey);

        // Explicit audit-log entry for this high-impact, irreversible
        // operation. Don't include the private key; record the new
        // selector + Stalwart signature ID + the actor identity so a
        // forensic timeline of key rotations is reconstructable.
        await app.db.insert(auditLogs).values({
          id: crypto.randomUUID(),
          actorId: (request.user as { sub?: string } | undefined)?.sub ?? 'system',
          actorType: 'user',
          actionType: 'email_domain.dkim.rotate',
          resourceType: 'email_domain',
          resourceId: domainId,
          changes: {
            tenantId,
            domainName: row.domainName,
            newSelector: result.newSelector,
            stalwartDkimSignatureId: result.stalwartDkimSignatureId,
            recommendedRetireOldAt: result.recommendedRetireOldAt,
          } as unknown as Record<string, unknown>,
        });

        return success(result);
      } catch (err) {
        if (err instanceof DkimRotationError) {
          throw new ApiError(
            err.code,
            err.message,
            err.code === 'EMAIL_DOMAIN_NOT_FOUND' ? 404 :
              err.code === 'EMAIL_DOMAIN_NOT_PROVISIONED' ? 409 :
                502,
          );
        }
        throw err;
      }
    },
  );
}
