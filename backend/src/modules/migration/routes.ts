/**
 * Cross-cluster tenant migration (R20) — routes.
 *
 *   POST /api/v1/admin/migration/list-tenants  — scan a mounted source target
 *   POST /api/v1/admin/migration/import        — import single/all discovered tenants
 *
 * Auth mirrors the DR recover routes it composes: Bearer `authenticate` +
 * admin panel + super_admin/admin role. The import reuses the recover route
 * (recreate + reconcile) pointed at the migration source's targetConfigId.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError, missingToken } from '../../shared/errors.js';
import { migrationListRequestSchema, migrationImportRequestSchema } from '@insula/api-contracts';
import { listMigrationTenants, importMigrationTenants } from './service.js';

function validationError(issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>): never {
  throw new ApiError(
    'VALIDATION_ERROR',
    issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; '),
    400,
  );
}

export async function migrationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  app.post('/admin/migration/list-tenants', {
    schema: {
      tags: ['Migration'],
      summary: 'List tenants on a mounted (read-only) source backup target',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = migrationListRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) validationError(parsed.error.issues);
    const scan = await listMigrationTenants(app, parsed.data.targetConfigId);
    return success({
      targetConfigId: parsed.data.targetConfigId,
      tenants: scan.tenants,
      scanned: scan.scanned,
      skipped: scan.skipped,
    });
  });

  app.post('/admin/migration/import', {
    schema: {
      tags: ['Migration'],
      summary: 'Import single/all tenants from a mounted source target',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = migrationImportRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) validationError(parsed.error.issues);
    const authHeader = request.headers.authorization;
    if (!authHeader) throw missingToken();
    if (parsed.data.scope === 'selected' && !(parsed.data.tenantIds && parsed.data.tenantIds.length)) {
      throw new ApiError('VALIDATION_ERROR', "scope 'selected' requires a non-empty tenantIds", 400);
    }

    const { results } = await importMigrationTenants(app, parsed.data, authHeader);
    const imported = results.filter((r) => r.ok && r.status !== 'dry-run' && r.status !== 'skipped').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    return success({
      targetConfigId: parsed.data.targetConfigId,
      total: results.length,
      imported,
      failed,
      skipped,
      dryRun: parsed.data.dryRun,
      results,
    });
  });
}
