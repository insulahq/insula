/**
 * HTTP routes for per-client mTLS provider CRUD + cert lifecycle.
 *
 *   GET    /api/v1/tenants/:tenantId/mtls-providers
 *   POST   /api/v1/tenants/:tenantId/mtls-providers                       (upload OR generate)
 *   PATCH  /api/v1/tenants/:tenantId/mtls-providers/:pid
 *   DELETE /api/v1/tenants/:tenantId/mtls-providers/:pid
 *   POST   /api/v1/tenants/:tenantId/mtls-providers/:pid/issue-cert
 *   GET    /api/v1/tenants/:tenantId/mtls-providers/:pid/certificates
 *   GET    /api/v1/tenants/:tenantId/mtls-providers/:pid/certificates/:certId
 *   GET    /api/v1/tenants/:tenantId/mtls-providers/:pid/certificates/:certId/pem
 *   POST   /api/v1/tenants/:tenantId/mtls-providers/:pid/certificates/:certId/revoke
 *   GET    /api/v1/tenants/:tenantId/mtls-providers/:pid/crl              → metadata JSON
 *   GET    /api/v1/tenants/:tenantId/mtls-providers/:pid/crl.pem          → CRL body (text)
 *
 * Auth + tenancy: every request is gated by `authenticate` + `requireRole`
 * (admin / super_admin / tenant_admin) + `requireTenantAccess`. The last
 * one reads `:tenantId` from the URL and enforces it matches the JWT's
 * `tenantId` claim — without it, a tenant_admin for tenant A could call
 * /tenants/<tenant-B>/... and read tenant B's CA / certs (IDOR).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import {
  mtlsProviderInputSchema,
  mtlsProviderUpdateSchema,
  mtlsIssueCertInputSchema,
  listCertificatesQuerySchema,
  revokeCertificateInputSchema,
} from '@k8s-hosting/api-contracts';
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  issueUserCert,
  listCertificates,
  getCertificate,
  getCertificatePem,
  revokeCertificate,
  unrevokeCertificate,
  deleteCertificate,
  getOrGenerateCrl,
  getCrlMetadata,
} from './service.js';
import { ingressMtlsConfigs } from '../../db/schema.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { reconcileIngress } from '../domains/k8s-ingress.js';
import { domains as domainsTable } from '../../db/schema.js';
import { tenants } from '../../db/schema.js';
import type { ZodError } from 'zod';

function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

function actingUserId(request: FastifyRequest): string | null {
  // request.user is set by `authenticate`. Different deployments use
  // different shapes — pick the first stable id field present.
  // `||` (not `??`) so empty-string ids are treated as missing.
  const u = (request as unknown as { user?: { id?: string; sub?: string } }).user;
  return (u?.id || u?.sub) ?? null;
}

export async function mtlsProvidersRoutes(app: FastifyInstance): Promise<void> {
  // Fail-closed: refuse to register the routes plugin if the at-rest
  // encryption key is missing. Falling back to a constant key would
  // silently encrypt CA private keys under known plaintext — a
  // DB-leak attacker would recover every CA private key.
  const encryptionKey = app.config?.PLATFORM_ENCRYPTION_KEY
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!encryptionKey || encryptionKey.length < 32) {
    throw new Error(
      'PLATFORM_ENCRYPTION_KEY is required (≥32 chars) — mTLS providers refuse to start with a null/short encryption key',
    );
  }

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'tenant_admin'));
  // requireTenantAccess gates every URL with a :tenantId param so a
  // tenant_admin JWT for tenant A cannot pivot to tenant B. Admin /
  // super_admin tokens (no tenantId claim) bypass this check and can
  // operate on any tenant — that's the platform-operator escape hatch.
  app.addHook('onRequest', requireTenantAccess());

  // Public base URL for the CRL distribution point. Derived from
  // configuration, NOT request headers — trusting X-Forwarded-Host
  // would let a hostile tenant return an attacker-controlled URL to
  // the next caller of GET /crl, which the UI displays as a copyable
  // link. Falls back to the request's own scheme+host only when no
  // PUBLIC_URL is configured (dev/local).
  const publicBaseUrl =
    app.config?.PUBLIC_URL
    ?? process.env.PUBLIC_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? null;

  function crlPublicUrl(tenantId: string, providerId: string, request: FastifyRequest): string {
    if (publicBaseUrl) {
      return `${publicBaseUrl.replace(/\/$/, '')}/api/v1/tenants/${tenantId}/mtls-providers/${providerId}/crl.pem`;
    }
    // Dev fallback. Logged once at startup below.
    const proto = request.protocol;
    const host = request.headers.host ?? 'localhost';
    return `${proto}://${host}/api/v1/tenants/${tenantId}/mtls-providers/${providerId}/crl.pem`;
  }
  if (!publicBaseUrl) {
    app.log.warn('PUBLIC_URL is not set — CRL distribution URLs will be derived from the request Host header. This is OK for local dev only.');
  }

  app.get('/tenants/:tenantId/mtls-providers', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const rows = await listProviders(app.db, tenantId);
    return success(rows);
  });

  app.post('/tenants/:tenantId/mtls-providers', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = mtlsProviderInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const created = await createProvider(app.db, encryptionKey, tenantId, parsed.data);
    return success(created);
  });

  app.patch('/tenants/:tenantId/mtls-providers/:pid', async (request) => {
    const { tenantId, pid } = request.params as { tenantId: string; pid: string };
    const parsed = mtlsProviderUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const updated = await updateProvider(app.db, encryptionKey, tenantId, pid, parsed.data);
    return success(updated);
  });

  app.delete('/tenants/:tenantId/mtls-providers/:pid', async (request) => {
    const { tenantId, pid } = request.params as { tenantId: string; pid: string };
    await deleteProvider(app.db, tenantId, pid);
    return success({ deleted: true });
  });

  // Issue a fresh user cert from this provider's CA. The cert + key
  // are returned ONCE; the private key is never persisted server-side.
  // The cert itself is now persisted (as of v2) for audit + revocation.
  app.post('/tenants/:tenantId/mtls-providers/:pid/issue-cert', async (request) => {
    const { tenantId, pid } = request.params as { tenantId: string; pid: string };
    const parsed = mtlsIssueCertInputSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const issued = await issueUserCert(app.db, encryptionKey, tenantId, pid, parsed.data);
    return success(issued);
  });

  app.get('/tenants/:tenantId/mtls-providers/:pid/certificates', async (request) => {
    const { tenantId, pid } = request.params as { tenantId: string; pid: string };
    const parsed = listCertificatesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const result = await listCertificates(app.db, tenantId, pid, parsed.data);
    return success(result);
  });

  app.get('/tenants/:tenantId/mtls-providers/:pid/certificates/:certId', async (request) => {
    const { tenantId, pid, certId } = request.params as { tenantId: string; pid: string; certId: string };
    const row = await getCertificate(app.db, tenantId, pid, certId);
    return success(row);
  });

  app.get('/tenants/:tenantId/mtls-providers/:pid/certificates/:certId/pem', async (request, reply) => {
    const { tenantId, pid, certId } = request.params as { tenantId: string; pid: string; certId: string };
    const { certPem, serialHex, subjectCn } =
      await getCertificatePem(app.db, encryptionKey, tenantId, pid, certId);
    // RFC 8555 — application/x-pem-file is the canonical type. Use a
    // Content-Disposition so browsers offer a clean filename.
    // Cache-Control: private,no-store because the response body is a
    // user-scoped credential — must not be cached by intermediaries.
    const safeCn = subjectCn.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'tenant';
    reply
      .header('Content-Type', 'application/x-pem-file')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="${safeCn}-${serialHex.slice(0, 8)}.pem"`);
    return certPem;
  });

  // Fan out annotation-sync to every route that consumes this provider
  // so the freshly-regenerated CRL lands in each route-mtls-* Secret
  // immediately. The service layer can't do this directly (no K8s
  // tenant by design — avoids cyclic deps). Used by revoke / unrevoke
  // / delete-cert: all three change the CRL membership and need to be
  // pushed to NGINX in the same request. Best-effort: K8s errors are
  // logged but don't fail the API call; the periodic reconciler will
  // pick up any laggards.
  async function fanOutCrlReconcile(tenantId: string, providerId: string, action: string): Promise<void> {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8s = createK8sClients(kubeconfigPath);
      // In the Traefik model the CRL is baked into the mTLS CA Secret
      // referenced by the per-route TLSOption + passTLSClientCert
      // Middleware. Every reconcileIngress() rebuilds that Secret from
      // the live DB row, so a single namespace-level reconcile is enough
      // to push the new CRL to every consuming route. (Iterating routes
      // would just duplicate work.)
      const consumers = await app.db
        .select({ routeId: ingressMtlsConfigs.ingressRouteId })
        .from(ingressMtlsConfigs)
        .where(eq(ingressMtlsConfigs.providerId, providerId));
      if (consumers.length === 0) return;
      const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId));
      if (!tenant?.kubernetesNamespace) return;
      try {
        await reconcileIngress(app.db, k8s, tenantId, tenant.kubernetesNamespace);
      } catch (err) {
        app.log.warn({ err, providerId, action }, `mtls-${action}: failed to push CRL via reconcile`);
      }
      // Touch the domains table reference to avoid unused-import churn
      // — keeps the explicit join schema available if the audit path
      // ever wants to log per-route results.
      void domainsTable;
    } catch (err) {
      // K8s tenant unavailable (no kubeconfig in tests / local dev).
      app.log.debug({ err, action }, `mtls-${action}: K8s reconcile skipped`);
    }
  }

  app.post('/tenants/:tenantId/mtls-providers/:pid/certificates/:certId/revoke', async (request) => {
    const { tenantId, pid, certId } = request.params as { tenantId: string; pid: string; certId: string };
    const parsed = revokeCertificateInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const result = await revokeCertificate(
      app.db,
      tenantId,
      pid,
      certId,
      parsed.data.reason,
      actingUserId(request),
    );
    await fanOutCrlReconcile(tenantId, pid, 'revoke');
    return success(result);
  });

  app.post('/tenants/:tenantId/mtls-providers/:pid/certificates/:certId/unrevoke', async (request) => {
    const { tenantId, pid, certId } = request.params as { tenantId: string; pid: string; certId: string };
    const result = await unrevokeCertificate(app.db, tenantId, pid, certId);
    await fanOutCrlReconcile(tenantId, pid, 'unrevoke');
    return success(result);
  });

  app.delete('/tenants/:tenantId/mtls-providers/:pid/certificates/:certId', async (request, reply) => {
    const { tenantId, pid, certId } = request.params as { tenantId: string; pid: string; certId: string };
    await deleteCertificate(app.db, tenantId, pid, certId);
    await fanOutCrlReconcile(tenantId, pid, 'delete');
    reply.status(204);
    return null;
  });

  // CRL metadata (JSON). The /crl.pem sibling below serves the raw body.
  app.get('/tenants/:tenantId/mtls-providers/:pid/crl', async (request) => {
    const { tenantId, pid } = request.params as { tenantId: string; pid: string };
    const meta = await getCrlMetadata(app.db, tenantId, pid, crlPublicUrl(tenantId, pid, request));
    return success(meta);
  });

  app.get('/tenants/:tenantId/mtls-providers/:pid/crl.pem', async (request, reply) => {
    const { tenantId, pid } = request.params as { tenantId: string; pid: string };
    const { crlPem, crlNumber, lastGeneratedAt } =
      await getOrGenerateCrl(app.db, encryptionKey, tenantId, pid);
    // Cache for 1 minute — long enough to absorb burst lookups, short
    // enough that a revocation propagates within the next reconcile
    // sweep (annotation-sync runs every 30s by default). ETag keys on
    // provider id + CRL number; both are globally unique, so the
    // header validates correctly across replicas.
    reply
      .header('Content-Type', 'application/x-pem-file')
      .header('Cache-Control', 'public, max-age=60')
      .header('ETag', `"crl-${pid}-${crlNumber}"`)
      .header('Last-Modified', lastGeneratedAt.toUTCString());
    return crlPem;
  });
}
