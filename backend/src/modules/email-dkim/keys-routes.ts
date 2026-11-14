/**
 * DKIM signing keys of one email domain, for the tenant panel's Settings tab.
 *
 * Endpoints:
 *   GET /api/v1/tenants/:tenantId/email-domains/:domainId/dkim/keys
 *   GET /api/v1/tenants/:tenantId/email-domains/:domainId/dkim/private-key
 *
 * `:domainId` is the EMAIL-DOMAIN id, the same id the rotate route beside it
 * takes. The list is reachable by the tenant's own admin and platform staff.
 * The private key is not for `support` (read-only staff) and needs a fresh
 * step-up; every hand-out is audited.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import type { DkimKeysResponse, DkimPrivateKey } from '@insula/api-contracts';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { auditLogs, emailDomains, domains } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { dkimSignatureGet, type StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';
import { assertFreshStepUp, attributionOf, type StepUpCaller } from '../auth/step-up-service.js';
import { resolveDkimAccountId, redactPemBlocks } from './signatures.js';
import { buildDkimKeyList, dkimTxtName, readPublishedDkimRecords } from './keys.js';
import { resolveSigningKey, type SigningKeyResult } from './private-key.js';
import { readKeptDkimPrivateKey } from './key-store.js';
import { platformEncryptionKey } from '../../shared/platform-encryption-key.js';

/** Same source as rotation (rotate-routes.ts). */
const encryptionKey = (): string => platformEncryptionKey();

const UNAVAILABLE_MESSAGE: Record<Extract<SigningKeyResult, { ok: false }>['reason'], string> = {
  no_signing_key: 'The mail server holds no active signing key for this domain. Rotate key creates one.',
  not_kept: 'This key was created before the platform kept a copy of the keys it makes, so it cannot be shown. Rotate key creates a new key that can be — the current one keeps signing alongside it for a while.',
  mismatch: 'The copy the platform kept is not the key the mail server signs with, so it is not shown. Rotate key creates a new key that can be.',
};

const paramsSchema = z.object({
  tenantId: z.string().uuid(),
  domainId: z.string().uuid(),
});

interface OwnedEmailDomain {
  readonly domainId: string;
  readonly domainName: string;
  readonly stalwartDomainId: string | null;
  readonly activeSelector: string | null;
}

/** The email domain named by the path, inside the path's tenant — or 404. */
async function ownedEmailDomain(db: Database, request: FastifyRequest): Promise<OwnedEmailDomain & { tenantId: string; emailDomainId: string }> {
  const parsedParams = paramsSchema.safeParse(request.params);
  if (!parsedParams.success) {
    throw new ApiError(
      'INVALID_PARAMS',
      parsedParams.error.issues.map((i) => i.message).join('; '),
      400,
    );
  }
  const { tenantId, domainId } = parsedParams.data;
  const [row] = await db
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
  return { ...row, tenantId, emailDomainId: domainId };
}

/** Every signature the mail server holds; its error text goes to the log only. */
async function readSignatures(request: FastifyRequest, emailDomainId: string): Promise<readonly StalwartDkimSignatureRow[]> {
  try {
    const accountId = await resolveDkimAccountId(process.env.STALWART_MGMT_URL);
    return await dkimSignatureGet({ accountId, baseUrl: process.env.STALWART_MGMT_URL });
  } catch (err) {
    // The mail server's own error text names internal hosts — it goes to
    // the log, and the caller (often a tenant) gets a plain sentence.
    request.log.warn(
      { err: redactPemBlocks(err instanceof Error ? err.message : String(err)).slice(0, 300), emailDomainId },
      'DKIM keys: listing signatures on the mail server failed',
    );
    throw new ApiError(
      'STALWART_UNREACHABLE',
      'The mail server did not answer, so the signing keys cannot be shown right now. Mail signing is not affected.',
      502,
    );
  }
}

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
      const row = await ownedEmailDomain(app.db, request);
      if (!row.stalwartDomainId) {
        return success<DkimKeysResponse>({ provisioned: false, keys: [] });
      }
      const rows = await readSignatures(request, row.emailDomainId);
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

  // The key that signs the domain's mail, so its owner can sign with it on
  // another server. Order: ownership (404 for someone else's domain, before
  // anything else can answer), then step-up, then the mail server.
  //
  // An API token needs no step-up (operator decision) and is held instead to
  // the strictest scope, `delete`: the key lets its holder sign mail as the
  // domain. `issuesCredential` keeps a TENANT agent from carrying it off —
  // it would keep working after the agent is disconnected.
  app.get(
    '/tenants/:tenantId/email-domains/:domainId/dkim/private-key',
    {
      config: { apiScope: 'delete', issuesCredential: true },
      onRequest: [
        authenticate,
        requireRole('super_admin', 'admin', 'tenant_admin'),
        requireTenantAccess(),
      ],
    },
    async (request, reply): Promise<{ data: DkimPrivateKey }> => {
      const row = await ownedEmailDomain(app.db, request);
      await assertFreshStepUp(app.db, request.user as StepUpCaller, 'dkim_private_key');
      if (!row.stalwartDomainId) {
        throw new ApiError(
          'DKIM_NOT_PROVISIONED',
          'This domain is not set up on the mail server yet, so it has no signing key.',
          409,
        );
      }
      const pick = await resolveSigningKey({
        rows: await readSignatures(request, row.emailDomainId),
        stalwartDomainId: row.stalwartDomainId,
        activeSelector: row.activeSelector,
        readKept: (selector) => readKeptDkimPrivateKey(app.db, row.emailDomainId, selector, encryptionKey()),
      });
      if (!pick.ok) {
        if (pick.reason === 'mismatch') {
          request.log.warn(
            { emailDomainId: row.emailDomainId, selector: pick.selector },
            'DKIM: the kept key copy does not match the key the mail server signs with; not shown',
          );
        }
        throw new ApiError('DKIM_KEY_UNAVAILABLE', UNAVAILABLE_MESSAGE[pick.reason], 409, {
          reason: pick.reason,
          ...(pick.selector ? { selector: pick.selector } : {}),
        });
      }

      const txtRecordName = dkimTxtName(pick.selector, row.domainName);
      const published = (await readPublishedDkimRecords(app.db, row.domainId, row.domainName))
        .some((r) => r.name === txtRecordName);
      const user = request.user as StepUpCaller;
      // Awaited, and fatal: a hand-out with no audit row is the one event an
      // operator would later need to find. Never put the key in `changes`.
      await app.db.insert(auditLogs).values({
        id: randomUUID(),
        tenantId: row.tenantId,
        actionType: 'read',
        resourceType: 'dkim_private_key',
        resourceId: row.emailDomainId,
        actorId: user.sub.slice(0, 36),
        actorType: 'user',
        httpMethod: 'GET',
        httpPath: request.url.slice(0, 500),
        httpStatus: 200,
        changes: {
          private_key_revealed: true, selector: pick.selector, domain: row.domainName,
          ...attributionOf(request.user),
        },
        ipAddress: request.ip,
      });

      reply
        .header('Cache-Control', 'private, no-store')
        .header('Pragma', 'no-cache');
      return success<DkimPrivateKey>({
        domain: row.domainName,
        selector: pick.selector,
        algorithm: pick.algorithm,
        txtRecordName,
        published,
        privateKeyPem: pick.privateKeyPem,
      });
    },
  );
}
