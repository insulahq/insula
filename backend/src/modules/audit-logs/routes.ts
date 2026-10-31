import type { FastifyInstance } from 'fastify';
import { eq, and, like, gte, lte, sql, getTableColumns } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { auditLogs } from '../../db/schema.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { paginated } from '../../shared/response.js';
import { encodeListCursor, listCursorCondition, listOrderBy, listSortKeySelect, resolveListSort, withoutSortKey, type SortFields } from '../../shared/list-sort.js';

/** Columns the audit log sorts by on the server — what the table shows. */
const AUDIT_LOG_SORT_FIELDS: SortFields = {
  createdAt: { expr: auditLogs.createdAt, kind: 'timestamp' },
  actionType: { expr: auditLogs.actionType, kind: 'text' },
  resourceType: { expr: auditLogs.resourceType, kind: 'text' },
  httpMethod: { expr: auditLogs.httpMethod, kind: 'text' },
  httpPath: { expr: auditLogs.httpPath, kind: 'text' },
  actorId: { expr: auditLogs.actorId, kind: 'text' },
  ipAddress: { expr: auditLogs.ipAddress, kind: 'text' },
};

export async function auditLogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/audit-logs — filterable audit log entries
  app.get('/admin/audit-logs', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const { limit, cursor, sortParam } = parsePaginationParams(query);
    const sort = resolveListSort(sortParam, AUDIT_LOG_SORT_FIELDS, { field: 'createdAt', direction: 'desc' });

    const conditions = [];
    if (query.tenant_id) conditions.push(eq(auditLogs.tenantId, query.tenant_id));
    if (query.action_type) conditions.push(eq(auditLogs.actionType, query.action_type));
    if (query.resource_type) conditions.push(eq(auditLogs.resourceType, query.resource_type));
    if (query.actor_id) conditions.push(eq(auditLogs.actorId, query.actor_id));
    if (query.http_method) conditions.push(eq(auditLogs.httpMethod, query.http_method));
    if (query.search) {
      const escaped = query.search.replace(/%/g, '\\%').replace(/_/g, '\\_');
      conditions.push(like(auditLogs.httpPath, `%${escaped}%`));
    }
    if (query.from) conditions.push(gte(auditLogs.createdAt, new Date(query.from)));
    if (query.to) conditions.push(lte(auditLogs.createdAt, new Date(query.to)));

    // The total counts the filtered set, not what is left after the cursor —
    // it used to shrink on every page.
    const filterWhere = conditions.length > 0 ? and(...conditions) : undefined;
    const after = listCursorCondition(cursor, 'audit_log', sort, AUDIT_LOG_SORT_FIELDS, auditLogs.id);
    const where = after ? and(...conditions, after) : filterWhere;

    const rows = await app.db
      .select({ ...getTableColumns(auditLogs), sortKey: listSortKeySelect(sort, AUDIT_LOG_SORT_FIELDS) })
      .from(auditLogs)
      .where(where)
      .orderBy(...listOrderBy(sort, AUDIT_LOG_SORT_FIELDS, auditLogs.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const nextCursor = hasMore && page.length > 0
      ? encodeListCursor('audit_log', sort, page[page.length - 1])
      : null;
    const data = withoutSortKey(page);

    const [countResult] = await app.db
      .select({ count: sql<number>`count(*)` })
      .from(auditLogs)
      .where(filterWhere);

    return paginated(data, {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: data.length,
      total_count: Number(countResult?.count ?? 0),
    });
  });
}
