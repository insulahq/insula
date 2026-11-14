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
import { redactPemBlocks, resolveDkimAccountId } from './signatures.js';
import { convergeDomainDkim, describeDkimConvergence } from './converge.js';
import { platformEncryptionKey } from '../../shared/platform-encryption-key.js';

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
        // replaces a hand-rolled `userRole === 'tenant_admin'
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

      // DNS-provider credentials and the kept key copy are encrypted with
      // PLATFORM_ENCRYPTION_KEY. The previous code read the nonexistent
      // ENCRYPTION_KEY var and made every rotation 500 unconditionally.
      const encryptionKey = platformEncryptionKey();

      let result: Awaited<ReturnType<typeof rotateDkimKey>>;
      try {
        result = await rotateDkimKey(app.db, domainId, encryptionKey);
      } catch (err) {
        const classified = err instanceof DkimRotationError && err.code !== 'STALWART_API_ERROR';
        // A failure on the mail server (or anywhere unclassified) carries text
        // that names internal hosts. Staff see it; a tenant gets a sentence,
        // and the detail goes to the log.
        if (!classified && userRole === 'tenant_admin') {
          request.log.warn(
            { err: redactPemBlocks(err instanceof Error ? err.message : String(err)).slice(0, 500), emailDomainId: domainId },
            'DKIM rotation failed',
          );
          throw new ApiError(
            'DKIM_ROTATION_FAILED',
            'The key could not be rotated. The current key keeps signing your mail; try again later or contact support.',
            502,
          );
        }
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
    },
  );

  // POST …/dkim/restore — the retry for a restore whose DNS check was
  // undecidable, and the repair for a selector Stalwart lost while keeping the
  // domain: puts back every missing A/B selector whose kept key DNS still
  // publishes, and mints only when none can be (restore.ts, converge.ts).
  // Staff only: it can mint a key, and the tenant has Rotate key for that.
  app.post<{ Params: RouteParams }>(
    '/tenants/:tenantId/email-domains/:domainId/dkim/restore',
    { onRequest: [authenticate, requireRole('super_admin', 'admin')] },
    async (request) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw new ApiError('INVALID_PARAMS', parsedParams.error.issues.map((i) => i.message).join('; '), 400);
      }
      const { tenantId, domainId } = parsedParams.data;
      const [row] = await app.db
        .select({
          edId: emailDomains.id,
          domainId: emailDomains.domainId,
          domainName: domains.domainName,
          stalwartDomainId: emailDomains.stalwartDomainId,
          dkimActiveSelector: emailDomains.dkimActiveSelector,
        })
        .from(emailDomains)
        .innerJoin(domains, eq(domains.id, emailDomains.domainId))
        .where(and(eq(emailDomains.id, domainId), eq(domains.tenantId, tenantId)));
      if (!row) {
        throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email domain '${domainId}' not found for tenant '${tenantId}'`, 404);
      }
      if (!row.stalwartDomainId) {
        throw new ApiError('EMAIL_DOMAIN_NOT_PROVISIONED', `Email domain '${row.domainName}' is not on the mail server yet`, 409);
      }
      let result: Awaited<ReturnType<typeof convergeDomainDkim>>;
      try {
        result = await convergeDomainDkim(app.db, {
          accountId: await resolveDkimAccountId(process.env.STALWART_MGMT_URL),
          stalwartDomainId: row.stalwartDomainId,
          baseUrl: process.env.STALWART_MGMT_URL,
          emailDomainId: row.edId,
          domainId: row.domainId,
          domainName: row.domainName,
          currentDbSelector: row.dkimActiveSelector,
          expectAutoPair: false,
          encryptionKey: platformEncryptionKey(),
          log: request.log,
        });
      } catch (err) {
        throw new ApiError('DKIM_RESTORE_FAILED',
          redactPemBlocks(err instanceof Error ? err.message : String(err)).slice(0, 500), 502);
      }
      await app.db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorId: (request.user as { sub?: string } | undefined)?.sub ?? 'system',
        actorType: 'user',
        actionType: 'email_domain.dkim.restore',
        resourceType: 'email_domain',
        resourceId: domainId,
        changes: {
          tenantId, domainName: row.domainName,
          restored: result.restored, minted: result.minted, undecidable: result.undecidable,
        } as unknown as Record<string, unknown>,
      });
      return success({ ...result, message: describeDkimConvergence(row.domainName, result) });
    },
  );
}
