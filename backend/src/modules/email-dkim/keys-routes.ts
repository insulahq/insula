/**
 * DKIM signing keys of one email domain, for the tenant panel's Settings tab.
 *
 * Endpoint:
 *   GET /api/v1/tenants/:tenantId/email-domains/:domainId/dkim/keys
 *
 * `:domainId` is the EMAIL-DOMAIN id, the same id the rotate route beside it
 * takes. Read-only; reachable by the tenant's own admin and platform staff.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import type { DkimKeysResponse } from '@insula/api-contracts';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { emailDomains, domains } from '../../db/schema.js';
import { dkimSignatureGet, type StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';
import { resolveDkimAccountId, redactPemBlocks } from './signatures.js';
import { buildDkimKeyList, readPublishedDkimRecords } from './keys.js';

const paramsSchema = z.object({
  tenantId: z.string().uuid(),
  domainId: z.string().uuid(),
});

export async function emailDkimKeysRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/tenants/:tenantId/email-domains/:domainId/dkim/keys',
    {
      onRequest: [
        authenticate,
        requireRole('super_admin', 'admin', 'support', 'tenant_admin'),
        requireTenantAccess(),
      ],
    },
    async (request): Promise<{ data: DkimKeysResponse }> => {
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw new ApiError(
          'INVALID_PARAMS',
          parsedParams.error.issues.map((i) => i.message).join('; '),
          400,
        );
      }
      const { tenantId, domainId } = parsedParams.data;

      const [row] = await app.db
        .select({
          domainId: emailDomains.domainId,
          domainName: domains.domainName,
          stalwartDomainId: emailDomains.stalwartDomainId,
          activeSelector: emailDomains.dkimActiveSelector,
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
      if (!row.stalwartDomainId) {
        return success<DkimKeysResponse>({ provisioned: false, keys: [] });
      }

      let rows: readonly StalwartDkimSignatureRow[];
      try {
        const accountId = await resolveDkimAccountId(process.env.STALWART_MGMT_URL);
        rows = await dkimSignatureGet({ accountId, baseUrl: process.env.STALWART_MGMT_URL });
      } catch (err) {
        // The mail server's own error text names internal hosts — it goes to
        // the log, and the caller (often a tenant) gets a plain sentence.
        request.log.warn(
          { err: redactPemBlocks(err instanceof Error ? err.message : String(err)).slice(0, 300), emailDomainId: domainId },
          'DKIM keys: listing signatures on the mail server failed',
        );
        throw new ApiError(
          'STALWART_UNREACHABLE',
          'The mail server did not answer, so the signing keys cannot be shown right now. Mail signing is not affected.',
          502,
        );
      }

      const published = await readPublishedDkimRecords(app.db, row.domainId, row.domainName);
      return success<DkimKeysResponse>({
        provisioned: true,
        keys: buildDkimKeyList({
          rows,
          stalwartDomainId: row.stalwartDomainId,
          domainName: row.domainName,
          activeSelector: row.activeSelector,
          published,
        }),
      });
    },
  );
}
