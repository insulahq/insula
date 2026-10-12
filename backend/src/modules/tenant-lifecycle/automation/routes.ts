/**
 * Automatic archive and delete — the admin panel's card at the top of
 * Platform → Tenant Lifecycle Hooks.
 *
 *   GET   /api/v1/admin/lifecycle/automation      settings, last run, and every
 *                                                 suspended and archived tenant
 *                                                 with the date its days count from
 *   PATCH /api/v1/admin/lifecycle/automation      change the settings; answers
 *                                                 them as they are stored now
 *   POST  /api/v1/admin/lifecycle/automation/run  start a sweep now (202; it
 *                                                 runs on after the answer)
 *
 * Registered by tenantLifecycleRoutes, whose hooks gate all three: an
 * authenticated admin-panel session with the super_admin or admin role — the
 * roles that may archive and delete a tenant by hand.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { tenantAutomationSettingsUpdateSchema, type TenantAutomationSettingsSaved } from '@insula/api-contracts';
import { auditLogs } from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';
import { jobAlreadyRunning, runExclusive } from '../../../shared/exclusive-run.js';
import { success } from '../../../shared/response.js';
import { createK8sClients, type K8sClients } from '../../k8s-provisioner/k8s-client.js';
import {
  getTenantAutomationStatus,
  sweepTenantsOnce,
  TENANT_AUTOMATION_JOB,
  TENANT_AUTOMATION_MAX_HOLD_MS,
  type AutomationDeps,
} from './real.js';
import { saveTenantAutomationSettings } from './settings.js';

/**
 * Start a sweep under the job's run lock and answer as soon as it is known
 * whether it started: a sweep may take hours, and the request that asked for
 * it must not wait. False — one is under way already.
 */
function startSweep(deps: AutomationDeps): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let began = false;
    runExclusive(deps.db, 'storage-auto-archive', async () => {
      began = true;
      resolve(true);
      await sweepTenantsOnce(deps, 'manual');
    }, { maxHoldMs: TENANT_AUTOMATION_MAX_HOLD_MS }).then((outcome) => {
      if (!outcome.ran) resolve(false);
    }, (err: unknown) => {
      if (!began) reject(err instanceof Error ? err : new Error(String(err)));
      else console.error('[tenant-automation] sweep failed:', err instanceof Error ? err.message : String(err));
    });
  });
}

const TAGS = ['TenantLifecycle'];
const SECURITY = [{ bearerAuth: [] }];

export function registerTenantAutomationRoutes(app: FastifyInstance): void {
  // One set of cluster clients for these routes, built at the first request
  // that needs it — not one per request.
  let k8s: K8sClients | null = null;
  const deps = (): AutomationDeps => {
    const config = app.config as Record<string, unknown>;
    k8s ??= createK8sClients(config.KUBECONFIG_PATH as string | undefined);
    return { db: app.db, k8s, config };
  };

  /** Who did what, on record. A failure to write it is logged, never the request's failure. */
  const audit = async (request: FastifyRequest, actionType: string, httpMethod: string, httpPath: string, httpStatus: number, changes: Record<string, unknown>): Promise<void> => {
    const user = request.user as { sub?: string; id?: string } | undefined;
    await app.db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      tenantId: null,
      actionType,
      resourceType: 'platform_settings',
      resourceId: null,
      actorId: user?.sub ?? user?.id ?? 'unknown',
      actorType: 'user',
      httpMethod,
      httpPath,
      httpStatus,
      changes,
      ipAddress: request.ip ?? null,
    }).catch((err: unknown) => {
      request.log.warn({ err }, `audit log write failed for ${actionType}`);
    });
  };

  app.get('/admin/lifecycle/automation', {
    schema: { tags: TAGS, summary: 'Automatic archive and delete: settings, last run, tenants in line', security: SECURITY },
  }, async () => success(await getTenantAutomationStatus(deps())));

  app.patch('/admin/lifecycle/automation', {
    // No body schema here on purpose: Fastify would drop a field it does not
    // know before the strict check below could refuse it.
    schema: { tags: TAGS, summary: 'Change the automatic archive and delete settings', security: SECURITY },
  }, async (request) => {
    const parsed = tenantAutomationSettingsUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApiError('VALIDATION_ERROR', issue.message, 400, { field: issue.path.join('.') });
    }
    const settings = await saveTenantAutomationSettings(app.db, parsed.data);
    // Switching automatic deletion on is as consequential as a delete; who
    // did it, and to what, must be on record.
    await audit(request, 'tenant_lifecycle_automation.update', 'PATCH', '/admin/lifecycle/automation', 200, parsed.data);
    // The stored settings and nothing else: the panel reads the status again
    // by itself, and a status that cannot be read just now must not turn a
    // save that happened into an error.
    return success({ settings } satisfies TenantAutomationSettingsSaved);
  });

  app.post('/admin/lifecycle/automation/run', {
    schema: { tags: TAGS, summary: 'Start the automatic archive and delete sweep now', security: SECURITY },
  }, async (request, reply) => {
    const started = await startSweep(deps());
    if (!started) throw jobAlreadyRunning('The automatic archive and delete sweep', TENANT_AUTOMATION_JOB);
    // A sweep archives and deletes tenants: the admin who started one by hand
    // is on record, like the one who switched it on.
    await audit(request, 'tenant_lifecycle_automation.run', 'POST', '/admin/lifecycle/automation/run', 202, { trigger: 'manual' });
    reply.status(202);
    return success({ started: true });
  });
}
