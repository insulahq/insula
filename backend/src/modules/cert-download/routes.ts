/**
 * Certificate download.
 *
 * Two ways in, deliberately:
 *
 *   1. `GET /api/v1/certs/:domain/download` — Bearer <cert token>.
 *      `config.skipAuth` exempts it from the global JWT hook so it verifies
 *      its OWN opaque token against `cert_download_tokens`. That is the whole
 *      point: on an OIDC-only deployment there is no password grant to script
 *      against, so without this an external server could never fetch its own
 *      renewed certificate. This route must never gain a JWT fallback.
 *
 *   2. `GET /tenants/:tenantId/domains/:domainId/ssl-cert/download` — normal
 *      session auth, backing the panel's download button. The spec originally
 *      said API-only; the button was added by operator decision 2026-09-03
 *      because minting a token for a one-off copy is disproportionate.
 *
 * Both hand out a PRIVATE KEY, so both:
 *   - set `Cache-Control: private, no-store` (never let an intermediary hold it)
 *   - write an audit row carrying `private_key_downloaded`
 *   - refuse to say anything about domains the caller cannot already see
 */

import crypto from 'crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { createCertTokenInputSchema } from '@insula/api-contracts';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { auditLogs } from '../../db/schema.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import {
  buildCertBundle,
  probeCertAvailability,
  resolveDomainById,
  resolveDomainByName,
  type CertBundle,
  type DomainRef,
} from './bundle.js';
import * as tokens from './token-service.js';

function getK8s() {
  try {
    return createK8sClients(process.env.KUBECONFIG_PATH);
  } catch {
    return null;
  }
}

/**
 * Audit every hand-out of key material.
 *
 * `changes.private_key_downloaded` is the flag the TLS design calls for. It is
 * fire-and-forget for the same reason the audit middleware is — a slow audit
 * write must not stall a deploy pipeline — but a FAILED write is logged rather
 * than swallowed, because a download with no audit row is exactly the event an
 * operator would later need to find.
 */
function auditDownload(
  db: Database,
  opts: {
    tenantId: string;
    domainId: string;
    actorId: string;
    actorType: 'user' | 'system';
    via: 'token' | 'panel';
    tokenName?: string;
    source: CertBundle['source'];
    ip: string;
    path: string;
    log: { error: (o: unknown, m: string) => void };
  },
): void {
  db.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      tenantId: opts.tenantId,
      actionType: 'read',
      resourceType: 'ssl_certificate',
      resourceId: opts.domainId.slice(0, 36),
      actorId: opts.actorId.slice(0, 36),
      actorType: opts.actorType,
      httpMethod: 'GET',
      httpPath: opts.path.slice(0, 500),
      httpStatus: 200,
      changes: {
        private_key_downloaded: true,
        via: opts.via,
        source: opts.source,
        ...(opts.tokenName ? { token_name: opts.tokenName } : {}),
      },
      ipAddress: opts.ip,
    })
    .catch((err) => opts.log.error({ err }, 'Failed to write certificate-download audit log'));
}

/**
 * Audit a token being minted or revoked.
 *
 * The generic audit middleware buckets `/tenants/:t/domains/:d/cert-tokens/:id`
 * as resourceType `domain` with the DOMAIN id, dropping the token id entirely —
 * so mint/revoke would be indistinguishable from an unrelated DNS-record edit
 * on the same domain. These are the credential-lifecycle events this feature
 * exists to make auditable, so they get their own resourceType and carry the
 * token id.
 */
function auditTokenLifecycle(
  db: Database,
  opts: {
    tenantId: string;
    domainId: string;
    tokenId: string;
    tokenName?: string;
    action: 'create' | 'delete';
    actorId: string;
    ip: string;
    path: string;
    log: { error: (o: unknown, m: string) => void };
  },
): void {
  db.insert(auditLogs)
    .values({
      id: crypto.randomUUID(),
      tenantId: opts.tenantId,
      actionType: opts.action,
      resourceType: 'cert_download_token',
      resourceId: opts.tokenId.slice(0, 36),
      actorId: opts.actorId.slice(0, 36),
      actorType: 'user',
      httpMethod: opts.action === 'create' ? 'POST' : 'DELETE',
      httpPath: opts.path.slice(0, 500),
      httpStatus: opts.action === 'create' ? 201 : 204,
      changes: {
        domain_id: opts.domainId,
        ...(opts.tokenName ? { token_name: opts.tokenName } : {}),
      },
      ipAddress: opts.ip,
    })
    .catch((err) => opts.log.error({ err }, 'Failed to write cert-token audit log'));
}

/** Filename-safe form of a hostname, for Content-Disposition. */
function safeFilename(domainName: string): string {
  return domainName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'certificate';
}

function sendPem(reply: FastifyReply, bundle: CertBundle): string {
  reply
    .header('Content-Type', 'application/x-pem-file')
    // The body is a private key. Never let a proxy, CDN or browser retain it.
    .header('Cache-Control', 'private, no-store')
    .header('Pragma', 'no-cache')
    // Defence in depth: nothing here is HTML, but a sniffed content type on a
    // PEM served from the API origin is a needless XSS surface.
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Disposition', `attachment; filename="${safeFilename(bundle.domainName)}.pem"`);
  return bundle.pem;
}

export async function certDownloadRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.PLATFORM_ENCRYPTION_KEY
    ?? process.env.PLATFORM_ENCRYPTION_KEY
    ?? '0'.repeat(64) /* Dev-only fallback — production requires PLATFORM_ENCRYPTION_KEY */;

  // ── 1. Token download — the OIDC-independent path ──────────────────────
  //
  // skipAuth means the global JWT hook does not run. Everything below is this
  // route's own authorisation, so read it as a unit.
  app.get('/certs/:domain/download', {
    config: { skipAuth: true },
    schema: {
      tags: ['TLS Certificates'],
      summary: 'Download a domain certificate bundle using a scoped token',
    },
  }, async (request, reply) => {
    const { domain } = request.params as { domain: string };
    const header = request.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    const verified = await tokens.verifyToken(app.db, presented);
    // One indistinguishable 401 for absent / malformed / unknown / revoked /
    // expired, so probing cannot enumerate valid tokens.
    if (!verified) {
      throw new ApiError('INVALID_CERT_TOKEN', 'Invalid or expired certificate token', 401);
    }

    // The token is bound to a domain. Resolve the NAME within the token's
    // tenant and require it to be that same domain — a token for example.com
    // must not fetch example.org even inside its own tenant.
    const ref = await resolveDomainByName(app.db, verified.tenantId, domain);
    if (!ref || ref.domainId !== verified.domainId) {
      throw new ApiError(
        'CERT_NOT_FOUND',
        `No certificate available for '${domain}' with this token`,
        404,
      );
    }

    const bundle = await buildCertBundle(app.db, getK8s(), ref, encryptionKey);
    if (!bundle) {
      throw new ApiError(
        'CERT_NOT_FOUND',
        `No certificate has been issued for '${ref.domainName}' yet`,
        404,
      );
    }

    await tokens.touchToken(app.db, verified.tokenId);
    auditDownload(app.db, {
      tenantId: ref.tenantId,
      domainId: ref.domainId,
      // No user is involved — the actor IS the token.
      actorId: verified.tokenId,
      actorType: 'system',
      via: 'token',
      tokenName: verified.name,
      source: bundle.source,
      ip: request.ip,
      path: request.url,
      log: request.log,
    });

    return sendPem(reply, bundle);
  });

  // ── 2. Session-authenticated routes (panel) ────────────────────────────
  app.register(async (scoped) => {
    scoped.addHook('onRequest', authenticate);
    scoped.addHook('onRequest', requireTenantAccess());

    const domainOr404 = async (tenantId: string, domainId: string): Promise<DomainRef> => {
      const ref = await resolveDomainById(scoped.db, tenantId, domainId);
      if (!ref) {
        throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found for this tenant`, 404);
      }
      return ref;
    };

    // Availability probe, so the button can be disabled with a reason instead
    // of firing a request that 404s.
    scoped.get('/tenants/:tenantId/domains/:domainId/ssl-cert/download-availability', {
      onRequest: [requireRole('super_admin', 'admin', 'support', 'tenant_admin')],
      schema: { tags: ['TLS Certificates'], summary: 'Whether a certificate is downloadable', security: [{ bearerAuth: [] }] },
    }, async (request) => {
      const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
      const ref = await domainOr404(tenantId, domainId);
      // probeCertAvailability, NOT buildCertBundle: this fires on every
      // SSL-tab page load (including for `support`, who may never hold the
      // key) and only needs a boolean and a date. The full builder would
      // decrypt the customer's private key into memory to answer that.
      const probe = await probeCertAvailability(scoped.db, getK8s(), ref);
      return success(probe
        ? {
          available: true,
          source: probe.source,
          reason: null,
          expiresAt: probe.expiresAt?.toISOString() ?? null,
        }
        : {
          available: false,
          source: null,
          reason: 'No certificate has been issued for this domain yet.',
          expiresAt: null,
        });
    });

    // The manual download button.
    //
    // tenant_admin and above only: `support` is read-only on the panel but has
    // no business holding a customer's private key, and neither does a
    // tenant_user.
    scoped.get('/tenants/:tenantId/domains/:domainId/ssl-cert/download', {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin')],
      schema: { tags: ['TLS Certificates'], summary: 'Download a domain certificate bundle', security: [{ bearerAuth: [] }] },
    }, async (request, reply) => {
      const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
      const ref = await domainOr404(tenantId, domainId);
      const bundle = await buildCertBundle(scoped.db, getK8s(), ref, encryptionKey);
      if (!bundle) {
        throw new ApiError('CERT_NOT_FOUND', `No certificate has been issued for '${ref.domainName}' yet`, 404);
      }
      const user = request.user as { sub?: string } | undefined;
      auditDownload(scoped.db, {
        tenantId: ref.tenantId,
        domainId: ref.domainId,
        actorId: user?.sub ?? 'unknown',
        actorType: 'user',
        via: 'panel',
        source: bundle.source,
        ip: request.ip,
        path: request.url,
        log: request.log,
      });
      return sendPem(reply, bundle);
    });

    // ── Token management ──
    scoped.get('/tenants/:tenantId/domains/:domainId/cert-tokens', {
      onRequest: [requireRole('super_admin', 'admin', 'support', 'tenant_admin')],
      schema: { tags: ['TLS Certificates'], summary: 'List certificate download tokens', security: [{ bearerAuth: [] }] },
    }, async (request) => {
      const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
      await domainOr404(tenantId, domainId);
      return success(await tokens.listTokens(scoped.db, tenantId, domainId));
    });

    scoped.post('/tenants/:tenantId/domains/:domainId/cert-tokens', {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin')],
      schema: { tags: ['TLS Certificates'], summary: 'Create a certificate download token', security: [{ bearerAuth: [] }] },
    }, async (request, reply) => {
      const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
      const parsed = createCertTokenInputSchema.safeParse(request.body);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ApiError(
          'INVALID_FIELD_VALUE',
          `Validation error: ${first.message} (${first.path.join('.')})`,
          400,
          { field: first.path.join('.') },
        );
      }
      const user = request.user as { sub?: string } | undefined;
      const created = await tokens.createToken(
        scoped.db, tenantId, domainId, parsed.data, user?.sub ?? null,
      );
      auditTokenLifecycle(scoped.db, {
        tenantId, domainId, tokenId: created.id, tokenName: created.name,
        action: 'create', actorId: user?.sub ?? 'unknown',
        ip: request.ip, path: request.url, log: request.log,
      });
      reply.status(201);
      return success(created);
    });

    scoped.delete('/tenants/:tenantId/domains/:domainId/cert-tokens/:tokenId', {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin')],
      schema: { tags: ['TLS Certificates'], summary: 'Revoke a certificate download token', security: [{ bearerAuth: [] }] },
    }, async (request, reply) => {
      const { tenantId, domainId, tokenId } = request.params as {
        tenantId: string; domainId: string; tokenId: string;
      };
      const revoked = await tokens.revokeToken(scoped.db, tenantId, domainId, tokenId);
      const user = request.user as { sub?: string } | undefined;
      // The row is hard-deleted, so this audit entry is the ONLY durable
      // record that the credential ever existed and was revoked.
      auditTokenLifecycle(scoped.db, {
        tenantId, domainId, tokenId, tokenName: revoked.name,
        action: 'delete', actorId: user?.sub ?? 'unknown',
        ip: request.ip, path: request.url, log: request.log,
      });
      reply.status(204).send();
    });
  });
}
