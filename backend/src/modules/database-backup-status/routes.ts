/**
 * Per-database backup status, read by both panels.
 *
 *   GET /api/v1/tenant/backups/databases                 — tenant panel; the
 *       tenant comes from the token and is the WHERE clause (no URL param)
 *   GET /api/v1/admin/tenants/:tenantId/database-backups — one tenant
 *   GET /api/v1/admin/database-backups/overdue           — every overdue
 *       database across tenants (bounded by what is overdue, so unpaginated)
 *
 * The tenant sees error text cut at the operator-only markers.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminDatabaseBackupStatus, DatabaseBackupStatus } from '@insula/api-contracts';
import { authenticate, requirePanel, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { tenantVisibleText } from '../../shared/operator-only-text.js';
import { databaseLabel, instanceLabel, loadRows, type SweepRow } from './sweep.js';

/** Overdue first, then by instance and database. */
function order(a: SweepRow, b: SweepRow): number {
  const ao = a.staleSince ? 0 : 1;
  const bo = b.staleSince ? 0 : 1;
  if (ao !== bo) return ao - bo;
  return instanceLabel(a).localeCompare(instanceLabel(b)) || a.databaseName.localeCompare(b.databaseName);
}

export function presentForTenant(r: SweepRow): DatabaseBackupStatus {
  return {
    subjectKey: r.subjectKey,
    deploymentId: r.deploymentId,
    deploymentName: r.deploymentName,
    engine: r.engine,
    instanceLabel: instanceLabel(r),
    databaseName: r.databaseName,
    databaseLabel: databaseLabel(r),
    lastAttemptAt: r.lastAttemptAt.toISOString(),
    lastStatus: r.lastStatus,
    lastError: r.lastError ? tenantVisibleText(r.lastError).trim() || null : null,
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
    const rows = await loadRows(app.db, { tenantId });
    return success({ databases: [...rows].sort(order).map(presentForAdmin) });
  });

  app.get('/admin/database-backups/overdue', {
    schema: { tags: ['DatabaseBackups-Admin'], summary: 'Overdue database backups across tenants', security: [{ bearerAuth: [] }] },
  }, async () => {
    const rows = await loadRows(app.db, { staleOnly: true });
    const sorted = [...rows].sort((a, b) => a.tenantName.localeCompare(b.tenantName) || order(a, b));
    return success({ databases: sorted.map(presentForAdmin) });
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
    const rows = await loadRows(app.db, { tenantId });
    return success({ databases: [...rows].sort(order).map(presentForTenant) });
  });
}
