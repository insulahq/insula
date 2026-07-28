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
 * Idempotency: NOT idempotent — each call flips the active selector
 * (dkim-1 ⇄ dkim-2) and mints a fresh key under it. Selector count is
 * bounded at two by design (A/B scheme, see ./selectors.ts), so
 * repeated clicks can't fan out — but rotating twice within the mail
 * retry horizon (~5 days) narrows the in-flight verification safety
 * of the reused selector. The tenant-panel UI requires a confirmation
 * modal.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import crypto from 'node:crypto';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
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
      onRequest: [
        authenticate,
        requireRole('super_admin', 'admin', 'tenant_admin', 'support'),
        // 2026-07-28: replaces a hand-rolled `userRole === 'tenant_admin'
        // && userTenantId !== tenantId` check in the handler. The shared
        // middleware is equivalent for tenant_admin AND additionally
        // fails closed on a tenant-panel token with no tenantId claim.
        requireTenantAccess(),
      ],
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

      // Caller-owns-tenant is enforced by requireTenantAccess() in the
      // onRequest chain above (fail-closed, shared with every other
      // tenant-scoped route). The email-domain ownership check below is
      // a SEPARATE assertion: it stops a platform admin mis-targeting a
      // domainId that belongs to a different tenant.
      const userRole = (request.user as { role?: string } | undefined)?.role;

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

      // DNS-provider credentials are encrypted with PLATFORM_ENCRYPTION_KEY
      // (same pattern as dns-records/service.ts; dev fallback is the zero
      // key). The previous code read the nonexistent ENCRYPTION_KEY var and
      // made every rotation 500 unconditionally.
      const encryptionKey =
        process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64);

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
            // Record the actor ROLE too: admin/support can rotate any
            // tenant's keys, so actorId alone doesn't tell a forensic
            // reader whether this was the tenant or platform staff.
            actorRole: userRole ?? 'unknown',
            newSelector: result.newSelector,
            previousSelector: result.previousSelector,
            destroyedSelectors: result.destroyedSelectors,
            stalwartDkimSignatureId: result.stalwartDkimSignatureId,
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
