import type { FastifyInstance } from 'fastify';
import { updateEolSettingsSchema } from '@insula/api-contracts';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { parseBody } from '../../shared/validate-body.js';
import { getEolSettings, updateEolSettings, runEolScan } from './service.js';

export async function eolScannerRoutes(app: FastifyInstance): Promise<void> {
  // ─── GET /api/v1/admin/eol-settings ─────────────────────────────────────

  app.get('/admin/eol-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['EOL Scanner'],
      summary: 'Get EOL policy settings',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const settings = await getEolSettings(app.db);
    return success(settings);
  });

  // ─── PATCH /api/v1/admin/eol-settings ───────────────────────────────────

  app.patch('/admin/eol-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['EOL Scanner'],
      summary: 'Update EOL policy settings',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          graceDays: { type: 'integer', minimum: 1, maximum: 365 },
          warningDays: { type: 'integer', minimum: 1, maximum: 365 },
          autoUpgradeEnabled: { type: 'boolean' },
        },
      },
    },
  }, async (request) => {
    const body = parseBody(updateEolSettingsSchema, request.body);
    const settings = await updateEolSettings(app.db, body);
    return success(settings);
  });

  // ─── POST /api/v1/admin/eol-scanner/run ─────────────────────────────────

  app.post('/admin/eol-scanner/run', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['EOL Scanner'],
      summary: 'Manually run the EOL scanner',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const userId = ((request as unknown as Record<string, unknown>).user as { sub?: string } | undefined)?.sub ?? 'system';
    const result = await runEolScan(app.db, userId);
    return success(result);
  });
}
