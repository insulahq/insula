import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess, requireTenantRoleByMethod } from '../../middleware/auth.js';
import { domains } from '../../db/schema.js';
import { createDomainSchema, updateDomainSchema } from './schema.js';
import * as service from './service.js';
import { bulkVerifyDomains, bulkDeleteDomains } from './bulk.js';
import { verifyDomain, getPlatformConfig } from './verification.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { listProviderGroups } from '../dns-servers/service.js';

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/dns-provider-groups — registered BEFORE requireTenantAccess
  // because this endpoint has no :tenantId in the path
  app.get('/dns-provider-groups', {
    onRequest: [requireRole('super_admin', 'admin', 'support', 'tenant_admin', 'tenant_user')],
  }, async () => {
    return success(await listProviderGroups(app.db));
  });

  // Phase 6: method-aware role guard — GET is open to all tenant
  // roles (including tenant_user), writes require tenant_admin.
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  const getK8s = () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      return createK8sClients(kubeconfigPath);
    } catch {
      return undefined;
    }
  };

  // GET /api/v1/admin/domains — list all domains across all tenants
  app.get('/admin/domains', {
    onRequest: [requireRole('super_admin', 'admin', 'support', 'read_only')],
  }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const paginationParams = parsePaginationParams(query);
    const search = typeof query.search === 'string' ? query.search : undefined;

    const result = await service.listAllDomains(app.db, { ...paginationParams, search });
    return paginated(result.data, result.pagination);
  });

  // POST /api/v1/tenants/:tenantId/domains
  app.post('/tenants/:tenantId/domains', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = createDomainSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const domain = await service.createDomain(app.db, tenantId, parsed.data, getK8s());
    reply.status(201).send(success(domain));
  });

  // GET /api/v1/tenants/:tenantId/domains
  app.get('/tenants/:tenantId/domains', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const paginationParams = parsePaginationParams(query);
    const search = typeof query.search === 'string' ? query.search : undefined;

    const result = await service.listDomains(app.db, tenantId, { ...paginationParams, search });
    return paginated(result.data, result.pagination);
  });

  // GET /api/v1/tenants/:tenantId/domains/:domainId
  app.get('/tenants/:tenantId/domains/:domainId', async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const domain = await service.getDomainById(app.db, tenantId, domainId);
    return success(domain);
  });

  // PATCH /api/v1/tenants/:tenantId/domains/:domainId
  app.patch('/tenants/:tenantId/domains/:domainId', async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const parsed = updateDomainSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateDomain(app.db, tenantId, domainId, parsed.data, getK8s());
    return success(updated);
  });

  // GET /api/v1/tenants/:tenantId/domains/:domainId/delete-preview
  //
  // Phase 3 round-3: dynamic cascade preview. Returns the exact list
  // of resources that deleteDomain would remove (DNS records,
  // email_domains + mailboxes + aliases, ingress routes, webmail
  // Ingress hostname) so the tenant-panel confirm dialog can render
  // a complete warning instead of a vague "this will remove stuff"
  // message.
  app.get('/tenants/:tenantId/domains/:domainId/delete-preview', async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const preview = await service.getDomainDeletePreview(app.db, tenantId, domainId);
    return success(preview);
  });

  // DELETE /api/v1/tenants/:tenantId/domains/:domainId
  app.delete('/tenants/:tenantId/domains/:domainId', async (request, reply) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const result = await service.deleteDomain(app.db, tenantId, domainId, getK8s());
    // Phase 3 round-3: log cascade counts for audit trail. The 204
    // response body is still empty so tenants that expect no body
    // don't break.
    app.log.info(
      { tenantId, domainId, deleted: result.deleted },
      'domains: deleteDomain cascaded deletions',
    );
    reply.status(204).send();
  });

  // POST /api/v1/tenants/:tenantId/domains/:domainId/verify
  //
  // Cache strategy: single POST with optional ?force=true query param.
  // - Without force: return cached result (with cached:true) if verification_cache_at
  //   is within 24 hours. This lets the tenant-panel auto-fire on mount without
  //   hammering DNS on every page load.
  // - With force=true (or stale cache): run full verification, store result.
  //
  // We chose single-POST-with-force over a separate GET because the verify
  // mutation already exists on both panels; callers that want a no-op read
  // can just check domain.verificationCacheAt before calling.
  app.post('/tenants/:tenantId/domains/:domainId/verify', async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const query = request.query as Record<string, unknown>;
    const force = query.force === 'true' || query.force === '1';

    const domain = await service.getDomainById(app.db, tenantId, domainId);

    // Cache check — skip if force=true
    const cacheAge = 24 * 60 * 60 * 1000; // 24 hours in ms
    const rawDomain = domain as Record<string, unknown>;
    const cacheAt = rawDomain.verificationCacheAt ? new Date(rawDomain.verificationCacheAt as string) : null;
    if (!force && cacheAt && (Date.now() - cacheAt.getTime()) < cacheAge) {
      const cachedResult = rawDomain.verificationCacheResult as { verified: boolean; checks: Array<{ type: string; status: string; detail: string }> } | null;
      if (cachedResult) {
        return success({ ...cachedResult, domainId, domainName: domain.domainName, cached: true });
      }
    }

    const platformConfig = await getPlatformConfig(app.db);
    const dnsMode = domain.dnsMode as 'primary' | 'cname' | 'secondary';

    // Wrap in a chip task so the operator sees the verify spinning
    // (DNS lookups across multiple resolvers + record-checks can take
    // 5-30s on stale cache misses). Idempotent on (kind, refId=domainId)
    // so concurrent verifies coalesce to one row.
    const userId = request.user?.sub ?? null;
    const taskScope = request.user?.panel === 'tenant' ? 'tenant' as const : 'admin' as const;

    const verifyAndPersist = async () => {
      const result = await verifyDomain(domain.domainName, dnsMode, platformConfig, app.db);
      const now = new Date();
      await service.setDomainVerificationStatus(app.db, domainId, result);
      await app.db.update(domains).set({ lastVerifiedAt: now }).where(eq(domains.id, domainId));
      return result;
    };

    let result;
    if (userId) {
      const { tracked } = await import('../tasks/service.js');
      const { toSafeText } = await import('@insula/api-contracts');
      result = await tracked(
        app.db,
        {
          kind: 'dns.verify',
          refId: domainId,
          scope: taskScope,
          userId,
          tenantId,
          label: toSafeText(`Verify DNS — ${domain.domainName}`),
          target: { type: 'route', href: `/tenants/${tenantId}/domains/${domainId}` },
        },
        verifyAndPersist,
      );
    } else {
      result = await verifyAndPersist();
    }

    return success({ ...result, domainId, domainName: domain.domainName, cached: false });
  });

  // POST /api/v1/tenants/:tenantId/domains/:domainId/migrate-dns
  app.post('/tenants/:tenantId/domains/:domainId/migrate-dns', async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const body = request.body as { target_group_id?: string };

    if (!body.target_group_id) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'target_group_id is required', 400, { field: 'target_group_id' });
    }

    const updated = await service.migrateDomainDns(app.db, tenantId, domainId, body.target_group_id);
    return success(updated);
  });

  // ─── Bulk Operations ────────────────────────────────────────────────────────

  // POST /api/v1/admin/domains/bulk
  app.post('/admin/domains/bulk', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const body = request.body as { domain_ids?: string[]; action?: string };

    if (!Array.isArray(body.domain_ids) || body.domain_ids.length === 0 || !body.action) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'domain_ids (non-empty array) and action are required', 400);
    }

    if (body.action !== 'verify' && body.action !== 'delete') {
      throw new ApiError('INVALID_FIELD_VALUE', "action must be 'verify' or 'delete'", 400, { field: 'action' });
    }

    if (body.action === 'verify') {
      const result = await bulkVerifyDomains(app.db, body.domain_ids);
      return success(result);
    }

    const result = await bulkDeleteDomains(app.db, body.domain_ids, getK8s());
    return success(result);
  });
}
