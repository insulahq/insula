import type { FastifyInstance } from 'fastify';
import { updateResourceQuotaSchema } from '@insula/api-contracts';
import crypto from 'node:crypto';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { parseBody } from '../../shared/validate-body.js';
import { validateQuotaFitsHeadroom } from './headroom-gate.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { auditLogs } from '../../db/schema.js';

export async function resourceQuotaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/tenants/:tenantId/resource-quota — anyone authenticated can view
  app.get('/tenants/:tenantId/resource-quota', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const quota = await service.getResourceQuota(app.db, tenantId);
    return success(quota);
  });

  // GET /api/v1/tenants/:tenantId/resource-availability — authenticated + tenant access
  app.get('/tenants/:tenantId/resource-availability', {
    onRequest: [authenticate, requireTenantAccess()],
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    // Pass the cluster client so the gate reconciles against the live
    // ResourceQuota — the thing that will actually refuse the deploy — and not
    // only against the platform's own `deployments` sum. See service.ts.
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const availability = await service.getTenantResourceAvailability(app.db, tenantId, {
      k8s: createK8sClients(kubeconfigPath),
      log: app.log,
    });
    return success(availability);
  });

  // PATCH /api/v1/tenants/:tenantId/resource-quota — admin only
  //
  // Cluster-headroom ADVISORY. Before saving, the effective ceiling of every
  // non-archived tenant is summed and compared against what this cluster can
  // carry. The verdict is logged, audited and returned with the write — it
  // never refuses. Oversubscription is an accepted position on this platform
  // (CPU requests are a scheduling hint, not a guarantee); the operator asked
  // to SEE the gap, not to be stopped at it. See headroom-gate.ts.
  //
  // `?force=true` is accepted and ignored — kept so scripts written against
  // the refusing version keep working. There is nothing left to force.
  app.patch('/tenants/:tenantId/resource-quota', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const input = parseBody(updateResourceQuotaSchema, request.body);
    const userSub = (request.user as { sub?: string } | undefined)?.sub ?? 'system';

    const newCpuLimit =
      typeof input.cpu_cores_limit === 'number' ? input.cpu_cores_limit : null;
    const newMemoryLimitGi =
      typeof input.memory_gb_limit === 'number' ? input.memory_gb_limit : null;

    // Only gate on CPU/memory changes — storage and bandwidth aren't
    // part of the failover-headroom computation. If the patch touches
    // only those fields, skip the headroom check.
    const gateApplies = newCpuLimit !== null || newMemoryLimitGi !== null;

    // Surfaced on the 200 alongside the write — the only place a caller of
    // this API-only endpoint would ever see it.
    let advisory: string | null = null;

    if (gateApplies) {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8s = createK8sClients(kubeconfigPath);
      const gate = await validateQuotaFitsHeadroom(app.db, k8s, {
        tenantId,
        newCpuLimit,
        newMemoryLimitGi,
      });

      if (!gate.withinBudget) {
        /**
         * ★ ADVISORY, not admission control.
         *
         * This used to return 409 and refuse the write. That was the wrong
         * policy for this platform: oversubscription is a deliberate,
         * accepted position here — CPU requests are a scheduling hint, not a
         * guarantee, and the operator asked for VISIBILITY into the gap, not
         * a gate across it. A guard that refuses an accepted state is not a
         * safety feature, it is an obstacle that teaches people to pass
         * ?force=true reflexively.
         *
         * So the measurement stays — it is honest and hard-won — and the
         * verdict is recorded rather than enforced. Reverting instead to the
         * old "sum an empty table" behaviour would have made the number
         * wrong as well as unenforced.
         *
         * Deliberately NOT a notification. This cluster is permanently past
         * the budget, so alerting per edit would fan a standing condition out
         * as a stream of alarms. The standing condition is already reported
         * once, deduped per node, by the CPU-reservation finding.
         */
        request.log.warn({
          tenantId,
          attempt: { newCpuLimit, newMemoryLimitGi },
          advisory: gate.reason,
          details: gate.details,
        }, 'resource quota accepted past cluster headroom (advisory)');

        await app.db.insert(auditLogs).values({
          id: crypto.randomUUID(),
          actorId: userSub,
          actorType: 'user',
          actionType: 'resource_quota.update.over_headroom',
          resourceType: 'resource_quota',
          resourceId: tenantId,
          changes: {
            reason: 'cluster_headroom_exceeded_advisory',
            advisory: gate.reason,
            attempt: { newCpuLimit, newMemoryLimitGi },
            details: gate.details,
          },
          httpStatus: 200,
        });
        advisory = gate.reason;
      }
    }

    const updated = await service.updateResourceQuota(app.db, tenantId, {
      cpu_cores_limit: input.cpu_cores_limit as number | undefined,
      memory_gb_limit: input.memory_gb_limit as number | undefined,
      storage_gb_limit: input.storage_gb_limit as number | undefined,
      bandwidth_gb_limit: input.bandwidth_gb_limit as number | undefined,
    });

    // Audit-log only when the patch actually carried at least one
    // changeable quota field — a no-op PATCH (empty body, or only fields
    // we don't recognise) shouldn't pollute the timeline. Storage and
    // bandwidth aren't gated but still count as real changes.
    const hasAnyField =
      input.cpu_cores_limit !== undefined ||
      input.memory_gb_limit !== undefined ||
      input.storage_gb_limit !== undefined ||
      input.bandwidth_gb_limit !== undefined;
    if (hasAnyField) {
      await app.db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorId: userSub,
        actorType: 'user',
        actionType: 'resource_quota.update',
        resourceType: 'resource_quota',
        resourceId: tenantId,
        changes: { patch: { newCpuLimit, newMemoryLimitGi } },
        httpStatus: 200,
      });
    }

    // `headroomAdvisory` is null on a quota that fits. Additive, so a client
    // that ignores it is unaffected.
    return success({ ...updated, headroomAdvisory: advisory });
  });
}
