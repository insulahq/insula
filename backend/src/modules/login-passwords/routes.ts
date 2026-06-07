/**
 * Login-password routes (a.k.a. app passwords) for a mailbox.
 *
 *   GET    /tenants/:tenantId/mailboxes/:mailboxId/login-passwords
 *   POST   /tenants/:tenantId/mailboxes/:mailboxId/login-passwords
 *   DELETE /tenants/:tenantId/mailboxes/:mailboxId/login-passwords/:credentialId
 *   (+ /admin/mailboxes/:mailboxId/login-passwords for support/super_admin)
 *
 * Stateless — backed by Stalwart AppPassword objects (see ./service.ts).
 * The cleartext secret is returned ONCE by POST and is NEVER logged,
 * audited, or persisted.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { z } from 'zod';
import { authenticate, requireRole, requireTenantAccess, requirePanel } from '../../middleware/auth.js';
import { createLoginPasswordSchema } from '@insula/api-contracts';
import { mailboxes, emailDomains, domains, auditLogs } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  listLoginPasswords,
  createLoginPassword,
  revokeLoginPassword,
  LoginPasswordError,
} from './service.js';

const uuid = z.string().uuid();
// Stalwart AppPassword ids are opaque short tokens (base32-ish), not
// UUIDs — validate by charset + length rather than UUID shape.
const credentialIdRe = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Map a LoginPasswordError to an ApiError; rethrow anything else
 * unchanged. Returns the ApiError so call sites `throw toApiError(err)`
 * (explicit control flow — the handler's return type stays honest).
 */
function toApiError(err: unknown): ApiError {
  if (err instanceof LoginPasswordError) {
    return new ApiError(err.code, err.message, err.status);
  }
  throw err;
}

function actor(request: { user?: unknown }): { id: string; role: string } {
  const u = request.user as { sub?: string; role?: string } | undefined;
  return { id: u?.sub ?? 'system', role: u?.role ?? 'unknown' };
}

/**
 * Resolve the owning tenant for a mailbox (admin path has no tenantId in
 * the URL). Returns null when the mailbox doesn't exist.
 */
async function tenantIdForMailbox(
  app: FastifyInstance,
  mailboxId: string,
): Promise<string | null> {
  const [row] = await app.db
    .select({ tenantId: domains.tenantId })
    .from(mailboxes)
    .innerJoin(emailDomains, eq(emailDomains.id, mailboxes.emailDomainId))
    .innerJoin(domains, eq(domains.id, emailDomains.domainId))
    .where(eq(mailboxes.id, mailboxId));
  return row?.tenantId ?? null;
}

async function auditLoginPassword(
  app: FastifyInstance,
  params: {
    tenantId: string;
    mailboxId: string;
    actionType: 'mailbox.login_password.create' | 'mailbox.login_password.revoke';
    actorId: string;
    actorRole: string;
    changes: Record<string, unknown>;
  },
): Promise<void> {
  await app.db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    tenantId: params.tenantId,
    actorId: params.actorId,
    actorType: 'user',
    actionType: params.actionType,
    resourceType: 'mailbox',
    resourceId: params.mailboxId,
    changes: { actorRole: params.actorRole, ...params.changes },
  });
}

export async function loginPasswordRoutes(app: FastifyInstance): Promise<void> {
  // ── Tenant scope ──────────────────────────────────────────────────────
  app.register(async (scope) => {
    scope.addHook('onRequest', authenticate);
    scope.addHook('onRequest', requireTenantAccess()); // tenant-panel → own tenant only

    const base = '/tenants/:tenantId/mailboxes/:mailboxId/login-passwords';

    scope.get(base, {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin', 'support', 'read_only')],
    }, async (request) => {
      const { tenantId, mailboxId } = parseTenantParams(request.params);
      try {
        return success(await listLoginPasswords(app.db, tenantId, mailboxId));
      } catch (err) { throw toApiError(err); }
    });

    scope.post(base, {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin', 'support')],
    }, async (request) => {
      const { tenantId, mailboxId } = parseTenantParams(request.params);
      const parsed = createLoginPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiError(
          'INVALID_FIELD_VALUE',
          parsed.error.issues.map((i) => `${i.message} (${i.path.join('.')})`).join('; '),
          400,
        );
      }
      try {
        const result = await createLoginPassword(app.db, tenantId, mailboxId, parsed.data);
        const a = actor(request);
        // Audit the LABEL + server id — never the secret.
        await auditLoginPassword(app, {
          tenantId, mailboxId,
          actionType: 'mailbox.login_password.create',
          actorId: a.id, actorRole: a.role,
          changes: { credentialId: result.id, label: result.label, expiresAt: result.expiresAt },
        });
        return success(result);
      } catch (err) { throw toApiError(err); }
    });

    scope.delete(`${base}/:credentialId`, {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin', 'support')],
    }, async (request, reply) => {
      const { tenantId, mailboxId } = parseTenantParams(request.params);
      const credentialId = parseCredentialId(request.params);
      try {
        await revokeLoginPassword(app.db, tenantId, mailboxId, credentialId);
        const a = actor(request);
        await auditLoginPassword(app, {
          tenantId, mailboxId,
          actionType: 'mailbox.login_password.revoke',
          actorId: a.id, actorRole: a.role,
          changes: { credentialId },
        });
        reply.status(204).send();
      } catch (err) { throw toApiError(err); }
    });
  });

  // ── Admin scope (cross-tenant; no tenantId in the URL) ────────────────
  app.register(async (scope) => {
    scope.addHook('onRequest', authenticate);
    // Defence-in-depth: the cross-tenant admin scope is admin-panel only.
    // requireRole already excludes tenant_admin, but pin the panel too so
    // a future role that satisfies requireRole can't reach it from a
    // tenant-panel token (matches backup-restore/cluster-health, etc.).
    scope.addHook('onRequest', requirePanel('admin'));

    const base = '/admin/mailboxes/:mailboxId/login-passwords';

    scope.get(base, {
      onRequest: [requireRole('super_admin', 'admin', 'support', 'read_only')],
    }, async (request) => {
      const mailboxId = parseMailboxId(request.params);
      const tenantId = await tenantIdForMailbox(app, mailboxId);
      if (!tenantId) throw new ApiError('MAILBOX_NOT_FOUND', `Mailbox '${mailboxId}' not found`, 404);
      try {
        return success(await listLoginPasswords(app.db, tenantId, mailboxId));
      } catch (err) { throw toApiError(err); }
    });

    scope.post(base, {
      onRequest: [requireRole('super_admin', 'admin', 'support')],
    }, async (request) => {
      const mailboxId = parseMailboxId(request.params);
      const parsed = createLoginPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiError(
          'INVALID_FIELD_VALUE',
          parsed.error.issues.map((i) => `${i.message} (${i.path.join('.')})`).join('; '),
          400,
        );
      }
      const tenantId = await tenantIdForMailbox(app, mailboxId);
      if (!tenantId) throw new ApiError('MAILBOX_NOT_FOUND', `Mailbox '${mailboxId}' not found`, 404);
      try {
        const result = await createLoginPassword(app.db, tenantId, mailboxId, parsed.data);
        const a = actor(request);
        await auditLoginPassword(app, {
          tenantId, mailboxId,
          actionType: 'mailbox.login_password.create',
          actorId: a.id, actorRole: a.role,
          changes: { credentialId: result.id, label: result.label, expiresAt: result.expiresAt },
        });
        return success(result);
      } catch (err) { throw toApiError(err); }
    });

    scope.delete(`${base}/:credentialId`, {
      onRequest: [requireRole('super_admin', 'admin', 'support')],
    }, async (request, reply) => {
      const mailboxId = parseMailboxId(request.params);
      const credentialId = parseCredentialId(request.params);
      const tenantId = await tenantIdForMailbox(app, mailboxId);
      if (!tenantId) throw new ApiError('MAILBOX_NOT_FOUND', `Mailbox '${mailboxId}' not found`, 404);
      try {
        await revokeLoginPassword(app.db, tenantId, mailboxId, credentialId);
        const a = actor(request);
        await auditLoginPassword(app, {
          tenantId, mailboxId,
          actionType: 'mailbox.login_password.revoke',
          actorId: a.id, actorRole: a.role,
          changes: { credentialId },
        });
        reply.status(204).send();
      } catch (err) { throw toApiError(err); }
    });
  });
}

function parseTenantParams(params: unknown): { tenantId: string; mailboxId: string } {
  const p = params as { tenantId?: string; mailboxId?: string };
  if (!uuid.safeParse(p.tenantId).success || !uuid.safeParse(p.mailboxId).success) {
    throw new ApiError('INVALID_PARAMS', 'tenantId and mailboxId must be UUIDs', 400);
  }
  return { tenantId: p.tenantId as string, mailboxId: p.mailboxId as string };
}

function parseMailboxId(params: unknown): string {
  const p = params as { mailboxId?: string };
  if (!uuid.safeParse(p.mailboxId).success) {
    throw new ApiError('INVALID_PARAMS', 'mailboxId must be a UUID', 400);
  }
  return p.mailboxId as string;
}

function parseCredentialId(params: unknown): string {
  const id = (params as { credentialId?: string }).credentialId;
  if (typeof id !== 'string' || !credentialIdRe.test(id)) {
    throw new ApiError('INVALID_PARAMS', 'credentialId is malformed', 400);
  }
  return id;
}
