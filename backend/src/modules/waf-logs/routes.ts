/**
 * WAF event retention + the "would block" summary.
 *
 *   GET   /admin/security/waf-log-settings      — retention, ceilings, what is stored (super_admin)
 *   PATCH /admin/security/waf-log-settings      — { retentionDays } (super_admin)
 *   GET   /admin/security/waf-events/summary    — grouped by host/rule/path, WAF Events filters (super_admin)
 *   GET   /tenants/:tenantId/routes/:routeId/waf-logs/summary?sinceSeconds= — one route, its tenant only
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  patchWafLogSettingsRequestSchema,
  tenantWafLogSummaryQuerySchema,
  wafEventsQuerySchema,
} from '@insula/api-contracts';
import { authenticate, requireRole, requireTenantAccess, requireTenantRoleByMethod } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { assertRouteOwnedByTenant } from '../ingress-routes/route-ownership.js';
import { loadWafLogSettings, saveRetentionDays } from './retention.js';
import { summarizeForAdmin, summarizeForRoute } from './summary.js';

const invalid = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): ApiError =>
  new ApiError('VALIDATION_ERROR', issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400);

export async function wafLogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/security/waf-log-settings', {
    onRequest: [authenticate],
    preHandler: requireRole('super_admin'),
  }, async () => success(await loadWafLogSettings(app.db)));

  app.patch('/admin/security/waf-log-settings', {
    onRequest: [authenticate],
    preHandler: requireRole('super_admin'),
  }, async (request: FastifyRequest) => {
    const parsed = patchWafLogSettingsRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw invalid(parsed.error.issues);
    await saveRetentionDays(app.db, parsed.data.retentionDays);
    app.log.warn({ actor: request.user?.sub ?? 'unknown', retentionDays: parsed.data.retentionDays }, 'waf-logs: retention changed');
    return success(await loadWafLogSettings(app.db));
  });

  app.get('/admin/security/waf-events/summary', {
    onRequest: [authenticate],
    preHandler: requireRole('super_admin'),
  }, async (request: FastifyRequest) => {
    const parsed = wafEventsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw invalid(parsed.error.issues);
    return success(await summarizeForAdmin(app.db, parsed.data));
  });

  app.get('/tenants/:tenantId/routes/:routeId/waf-logs/summary', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route WAF'],
      summary: 'WAF events of a route grouped by rule and path',
      security: [{ bearerAuth: [] }],
    },
  }, async (request: FastifyRequest) => {
    const { tenantId, routeId } = request.params as { tenantId: string; routeId: string };
    const parsed = tenantWafLogSummaryQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw invalid(parsed.error.issues);
    await assertRouteOwnedByTenant(app.db, routeId, tenantId);
    return success(await summarizeForRoute(app.db, routeId, parsed.data.sinceSeconds));
  });
}
