import type { FastifyInstance } from 'fastify';
import { eq, and, desc, lt, sql, or, ilike } from 'drizzle-orm';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { createMailboxSchema, updateMailboxSchema, mailboxAccessSchema } from '@insula/api-contracts';
import { mailboxes, tenants, emailDomains, domains } from '../../db/schema.js';
import * as service from './service.js';
import { success, paginated } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { parsePaginationParams, encodeCursor, decodeCursor } from '../../shared/pagination.js';
import type { JwtPayload } from '../../middleware/auth.js';

export async function mailboxRoutes(app: FastifyInstance): Promise<void> {
  // ─── Admin cross-tenant mailbox list ───
  //
  // Cursor-paginated by created_at descending. Search matches
  // local_part / full_address / display_name / email_domain.domain_name
  // / tenant.name. Used by the admin Tenants → Email Accounts tab.

  app.register(async (adminScope) => {
    adminScope.addHook('onRequest', authenticate);

    adminScope.get('/admin/mailboxes', {
      onRequest: [requireRole('super_admin', 'admin', 'support', 'read_only')],
    }, async (request) => {
      const query = request.query as Record<string, unknown>;
      const { limit, cursor } = parsePaginationParams(query);
      const search = typeof query.search === 'string' && query.search.length > 0 ? query.search : undefined;

      const filters = [];
      if (search) {
        const pattern = `%${search}%`;
        const orExpr = or(
          ilike(mailboxes.localPart, pattern),
          ilike(mailboxes.fullAddress, pattern),
          ilike(mailboxes.displayName, pattern),
          ilike(domains.domainName, pattern),
          ilike(tenants.name, pattern),
        );
        if (orExpr) filters.push(orExpr);
      }

      const cursorConds = [];
      if (cursor) {
        const decoded = decodeCursor(cursor);
        cursorConds.push(lt(mailboxes.createdAt, new Date(decoded.sort)));
      }
      const allConds = [...filters, ...cursorConds];
      const where = allConds.length === 0
        ? undefined
        : allConds.length === 1 ? allConds[0] : and(...allConds);

      const rows = await app.db
        .select({
          id: mailboxes.id,
          emailDomainId: mailboxes.emailDomainId,
          tenantId: mailboxes.tenantId,
          localPart: mailboxes.localPart,
          fullAddress: mailboxes.fullAddress,
          displayName: mailboxes.displayName,
          quotaMb: mailboxes.quotaMb,
          usedMb: mailboxes.usedMb,
          status: mailboxes.status,
          mailboxType: mailboxes.mailboxType,
          autoReply: mailboxes.autoReply,
          autoReplySubject: mailboxes.autoReplySubject,
          createdAt: mailboxes.createdAt,
          updatedAt: mailboxes.updatedAt,
          tenantName: tenants.name,
          emailDomain: domains.domainName,
        })
        .from(mailboxes)
        .leftJoin(tenants, eq(mailboxes.tenantId, tenants.id))
        .leftJoin(emailDomains, eq(mailboxes.emailDomainId, emailDomains.id))
        .leftJoin(domains, eq(emailDomains.domainId, domains.id))
        .where(where)
        .orderBy(desc(mailboxes.createdAt))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const data = rows.slice(0, limit);

      let nextCursor: string | null = null;
      if (hasMore && data.length > 0) {
        const last = data[data.length - 1];
        nextCursor = encodeCursor({
          resource: 'mailbox',
          sort: last.createdAt.toISOString(),
          id: last.id,
        });
      }

      const countWhere = filters.length === 0
        ? undefined
        : filters.length === 1 ? filters[0] : and(...filters);
      const [countResult] = await app.db
        .select({ count: sql<number>`count(*)` })
        .from(mailboxes)
        .leftJoin(tenants, eq(mailboxes.tenantId, tenants.id))
        .leftJoin(emailDomains, eq(mailboxes.emailDomainId, emailDomains.id))
        .leftJoin(domains, eq(emailDomains.domainId, domains.id))
        .where(countWhere);

      return paginated(
        data.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        {
          cursor: nextCursor,
          has_more: hasMore,
          page_size: data.length,
          total_count: Number(countResult?.count ?? 0),
        },
      );
    });
  });

  // ─── Client-scoped mailbox CRUD ───

  app.register(async (tenantScope) => {
    tenantScope.addHook('onRequest', authenticate);
    tenantScope.addHook('onRequest', requireTenantAccess());

    // POST /api/v1/tenants/:tenantId/email/domains/:emailDomainId/mailboxes
    tenantScope.post('/tenants/:tenantId/email/domains/:emailDomainId/mailboxes', {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin')],
    }, async (request, reply) => {
      const { tenantId, emailDomainId } = request.params as { tenantId: string; emailDomainId: string };
      const parsed = createMailboxSchema.safeParse(request.body);
      if (!parsed.success) {
        const firstError = parsed.error.issues[0];
        throw new ApiError(
          'MISSING_REQUIRED_FIELD',
          `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
          400,
          { field: firstError.path.join('.') },
        );
      }

      const created = await service.createMailbox(app.db, tenantId, emailDomainId, parsed.data);
      reply.status(201).send(success(created));
    });

    // GET /api/v1/tenants/:tenantId/mailboxes
    tenantScope.get('/tenants/:tenantId/mailboxes', {
      onRequest: [requireRole('super_admin', 'admin', 'support', 'tenant_admin', 'tenant_user')],
    }, async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      const query = request.query as Record<string, unknown>;
      const emailDomainId = typeof query.email_domain_id === 'string' ? query.email_domain_id : undefined;

      const data = await service.listMailboxes(app.db, tenantId, emailDomainId);
      return success(data);
    });

    // GET /api/v1/tenants/:tenantId/mail/mailbox-usage
    //
    // Phase 4/5 of tenant-panel email parity round 2: expose the
    // computed plan-based limit + current count so the tenant panel
    // can render a usage bar. Returns { limit, current, source,
    // remaining } — source is 'plan' or 'tenant_override'.
    tenantScope.get('/tenants/:tenantId/mail/mailbox-usage', {
      onRequest: [requireRole('super_admin', 'admin', 'support', 'tenant_admin', 'tenant_user')],
    }, async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      const { getTenantMailboxLimit, getTenantMailboxCount } = await import('./limit.js');
      const limit = await getTenantMailboxLimit(app.db, tenantId);
      const current = await getTenantMailboxCount(app.db, tenantId);
      return success({
        limit: limit.limit,
        current,
        source: limit.source,
        remaining: Math.max(0, limit.limit - current),
      });
    });

    // GET /api/v1/tenants/:tenantId/mailboxes/:id
    tenantScope.get('/tenants/:tenantId/mailboxes/:id', {
      onRequest: [requireRole('super_admin', 'admin', 'support', 'tenant_admin')],
    }, async (request) => {
      const { tenantId, id } = request.params as { tenantId: string; id: string };
      const record = await service.getMailbox(app.db, tenantId, id);
      return success(record);
    });

    // PATCH /api/v1/tenants/:tenantId/mailboxes/:id
    tenantScope.patch('/tenants/:tenantId/mailboxes/:id', {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin')],
    }, async (request) => {
      const { tenantId, id } = request.params as { tenantId: string; id: string };
      const parsed = updateMailboxSchema.safeParse(request.body);
      if (!parsed.success) {
        const firstError = parsed.error.issues[0];
        throw new ApiError(
          'MISSING_REQUIRED_FIELD',
          `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
          400,
          { field: firstError.path.join('.') },
        );
      }

      const updated = await service.updateMailbox(app.db, tenantId, id, parsed.data);
      return success(updated);
    });

    // DELETE /api/v1/tenants/:tenantId/mailboxes/:id
    tenantScope.delete('/tenants/:tenantId/mailboxes/:id', {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin')],
    }, async (request, reply) => {
      const { tenantId, id } = request.params as { tenantId: string; id: string };
      await service.deleteMailbox(app.db, tenantId, id);
      reply.status(204).send();
    });

    // ─── Access management ───

    // GET /api/v1/tenants/:tenantId/mailboxes/:id/access
    tenantScope.get('/tenants/:tenantId/mailboxes/:id/access', {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin')],
    }, async (request) => {
      const { tenantId, id } = request.params as { tenantId: string; id: string };
      // Verify mailbox belongs to tenant
      await service.getMailbox(app.db, tenantId, id);
      const rows = await service.listMailboxAccess(app.db, id);
      return success(rows);
    });

    // POST /api/v1/tenants/:tenantId/mailboxes/:id/access
    tenantScope.post('/tenants/:tenantId/mailboxes/:id/access', {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin')],
    }, async (request, reply) => {
      const { tenantId, id } = request.params as { tenantId: string; id: string };
      const parsed = mailboxAccessSchema.safeParse(request.body);
      if (!parsed.success) {
        const firstError = parsed.error.issues[0];
        throw new ApiError(
          'MISSING_REQUIRED_FIELD',
          `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
          400,
          { field: firstError.path.join('.') },
        );
      }

      // Verify mailbox belongs to tenant
      await service.getMailbox(app.db, tenantId, id);
      const created = await service.grantMailboxAccess(app.db, id, parsed.data.user_id, parsed.data.access_level);
      reply.status(201).send(success(created));
    });

    // DELETE /api/v1/tenants/:tenantId/mailboxes/:id/access/:userId
    tenantScope.delete('/tenants/:tenantId/mailboxes/:id/access/:userId', {
      onRequest: [requireRole('super_admin', 'admin', 'tenant_admin')],
    }, async (request, reply) => {
      const { tenantId, id, userId } = request.params as { tenantId: string; id: string; userId: string };
      // Verify mailbox belongs to tenant
      await service.getMailbox(app.db, tenantId, id);
      await service.revokeMailboxAccess(app.db, id, userId);
      reply.status(204).send();
    });
  });

  // ─── Webmail SSO (authenticated user, no tenant param) ───

  app.register(async (webmailScope) => {
    webmailScope.addHook('onRequest', authenticate);

    // POST /api/v1/email/webmail-token
    //
    // Phase 3.A.3: tighter per-route rate limit. The global limit is
    // 100/min per user; here we cap at 5/min because each token grants
    // full IMAP read/write access to the mailbox. This limits the
    // blast radius if an authenticated session is compromised and an
    // attacker tries to farm tokens for persistence.
    webmailScope.post('/email/webmail-token', {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    }, async (request) => {
      const user = request.user as JwtPayload;
      const { webmailTokenRequestSchema } = await import('@insula/api-contracts');
      const parsed = webmailTokenRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const firstError = parsed.error.issues[0];
        throw new ApiError(
          'MISSING_REQUIRED_FIELD',
          `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
          400,
          { field: firstError.path.join('.') },
        );
      }
      const result = await service.generateWebmailToken(
        app,
        app.db,
        user.sub,
        parsed.data.mailbox_id,
        {
          engine: parsed.data.engine,
          tenantId: user.tenantId,
          actorUserId: user.sub,
        },
      );
      return success(result);
    });

    // GET /api/v1/email/accessible-mailboxes
    webmailScope.get('/email/accessible-mailboxes', async (request) => {
      const user = request.user as JwtPayload;

      if (!user.tenantId) {
        throw new ApiError('CLIENT_REQUIRED', 'User must belong to a tenant to access mailboxes', 400);
      }

      const data = await service.getAccessibleMailboxes(app.db, user.sub, user.tenantId);
      return success(data);
    });
  });

  // ─── Admin routes ───

  app.register(async (adminScope) => {
    adminScope.addHook('onRequest', authenticate);
    adminScope.addHook('onRequest', requireRole('super_admin', 'admin'));

    // GET /api/v1/admin/email/mailboxes
    adminScope.get('/admin/email/mailboxes', async () => {
      const rows = await app.db
        .select({
          id: mailboxes.id,
          emailDomainId: mailboxes.emailDomainId,
          tenantId: mailboxes.tenantId,
          localPart: mailboxes.localPart,
          fullAddress: mailboxes.fullAddress,
          displayName: mailboxes.displayName,
          quotaMb: mailboxes.quotaMb,
          usedMb: mailboxes.usedMb,
          status: mailboxes.status,
          mailboxType: mailboxes.mailboxType,
          autoReply: mailboxes.autoReply,
          createdAt: mailboxes.createdAt,
          updatedAt: mailboxes.updatedAt,
        })
        .from(mailboxes);

      return success(rows);
    });
  });
}
