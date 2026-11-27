/**
 * Per-database backup status, read by both panels. Every list is a keyset
 * page (`limit` ≤ 100, opaque `cursor`), so a tenant with many databases or
 * SQLite files cannot make one response unbounded.
 *
 *   GET /api/v1/tenant/backups/databases                 — tenant panel; the
 *       tenant comes from the token and is the WHERE clause (no URL param)
 *   GET /api/v1/admin/tenants/:tenantId/database-backups — one tenant
 *   GET /api/v1/admin/database-backups/overdue           — every overdue
 *       database across tenants
 *
 * The tenant is told what KIND of failure the last attempt was, never its
 * text: dump errors are written by database clients and Kubernetes, not for
 * a tenant (error-kind.ts).
 */

import type { FastifyInstance } from 'fastify';
import { MAX_PAGE_LIMIT, type AdminDatabaseBackupStatus, type DatabaseBackupStatus } from '@insula/api-contracts';
import { z } from 'zod';
import { authenticate, requirePanel, requireRole } from '../../middleware/auth.js';
import { paginated } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { decodeCursor, encodeCursor } from '../../shared/pagination.js';
import { DUMP_ERROR_LABELS, dumpErrorKind } from './error-kind.js';
import { databaseLabel, instanceLabel, loadRowPage, pageKey, type SweepRow } from './sweep.js';

const CURSOR_RESOURCE = 'database-backups';

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(MAX_PAGE_LIMIT),
  cursor: z.string().max(4096).optional(),
});

function parsePage(query: unknown, scope: 'tenant' | 'fleet'): { limit: number; after?: string[] } {
  const q = pageQuerySchema.safeParse(query ?? {});
  if (!q.success) throw new ApiError('VALIDATION_ERROR', `limit must be 1–${MAX_PAGE_LIMIT}`, 400);
  if (!q.data.cursor) return { limit: q.data.limit };
  const c = decodeCursor(q.data.cursor);
  let after: unknown;
  try { after = JSON.parse(c.sort); } catch { after = null; }
  const width = scope === 'tenant' ? 3 : 4;
  if (c.resource !== `${CURSOR_RESOURCE}:${scope}` || !Array.isArray(after) || after.length !== width
    || !after.every((v) => typeof v === 'string')) {
    throw new ApiError('INVALID_CURSOR', 'Pagination cursor is invalid or expired', 400, undefined, 'Restart pagination from beginning');
  }
  return { limit: q.data.limit, after: after as string[] };
}

function nextCursor(rows: readonly SweepRow[], hasMore: boolean, scope: 'tenant' | 'fleet'): string | null {
  const last = rows[rows.length - 1];
  if (!hasMore || !last) return null;
  return encodeCursor({ resource: `${CURSOR_RESOURCE}:${scope}`, sort: JSON.stringify(pageKey(last, scope)), id: 'k' });
}

export function presentForTenant(r: SweepRow): DatabaseBackupStatus {
  const kind = dumpErrorKind(r.lastError);
  return {
    subjectKey: r.subjectKey,
    deploymentId: r.deploymentId,
    deploymentName: r.deploymentName,
    engine: r.engine,
    instanceLabel: instanceLabel(r),
    instanceState: r.instanceState,
    databaseName: r.databaseName,
    databaseLabel: databaseLabel(r),
    lastAttemptAt: r.lastAttemptAt.toISOString(),
    lastStatus: r.lastStatus,
    lastErrorKind: kind,
    lastErrorLabel: kind ? DUMP_ERROR_LABELS[kind] : null,
    lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
    lastSuccessSizeBytes: r.lastSuccessSizeBytes,
    overdue: r.staleSince !== null,
    overdueSince: r.staleSince?.toISOString() ?? null,
  };
}

export function presentForAdmin(r: SweepRow): AdminDatabaseBackupStatus {
  return {
    ...presentForTenant(r),
    lastError: r.lastError,
    tenantId: r.tenantId,
    tenantName: r.tenantName,
  };
}

export async function databaseBackupStatusAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  app.get('/admin/tenants/:tenantId/database-backups', {
    schema: { tags: ['DatabaseBackups-Admin'], summary: "A tenant's database backup status", security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = z.object({ tenantId: z.string().min(1).max(64) }).parse(request.params);
    const page = parsePage(request.query, 'tenant');
    const { rows, hasMore } = await loadRowPage(app.db, { tenantId }, page);
    return paginated(rows.map(presentForAdmin), {
      cursor: nextCursor(rows, hasMore, 'tenant'), has_more: hasMore, page_size: page.limit,
    });
  });

  app.get('/admin/database-backups/overdue', {
    schema: { tags: ['DatabaseBackups-Admin'], summary: 'Overdue database backups across tenants', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const page = parsePage(request.query, 'fleet');
    const { rows, hasMore } = await loadRowPage(app.db, { staleOnly: true }, page);
    return paginated(rows.map(presentForAdmin), {
      cursor: nextCursor(rows, hasMore, 'fleet'), has_more: hasMore, page_size: page.limit,
    });
  });
}

export async function databaseBackupStatusTenantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('tenant'));

  app.get('/tenant/backups/databases', {
    schema: { tags: ['DatabaseBackups-Client'], summary: 'My database backup status', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const tenantId = (request.user as { tenantId?: string } | undefined)?.tenantId;
    if (!tenantId) throw new ApiError('CLIENT_ACCESS_DENIED', 'Client-panel token missing tenantId', 403);
    const page = parsePage(request.query, 'tenant');
    const { rows, hasMore } = await loadRowPage(app.db, { tenantId }, page);
    return paginated(rows.map(presentForTenant), {
      cursor: nextCursor(rows, hasMore, 'tenant'), has_more: hasMore, page_size: page.limit,
    });
  });
}
