/**
 * Tenant health / cluster outage impact routes.
 *
 * One endpoint serves both operator surfaces added after the 2026-09-11
 * drill — the global outage banner (needs the node list + a count) and the
 * affected-tenants modal (needs the per-tenant findings) — so opening the
 * modal costs no extra cluster read.
 *
 * Cached briefly: the banner polls from every admin page, and four cluster
 * LISTs per poll per operator would be a self-inflicted load problem during
 * an outage. 15 s is well inside the useful resolution for a node outage
 * (Kubernetes itself takes ~40 s to mark a node NotReady).
 */
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { collectFacts } from './collect.js';
import { computeOutageImpact } from './service.js';
import { ApiError } from '../../shared/errors.js';
import { tenantRepinRequestSchema } from '@insula/api-contracts';
import type { ClusterOutageImpact } from '@insula/api-contracts';

const CACHE_TTL_MS = 15_000;

let cached: { at: number; value: ClusterOutageImpact } | null = null;

/** Exported for tests — lets a case start from a known-cold cache. */
export function resetOutageImpactCache(): void {
  cached = null;
}

export async function tenantHealthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  /**
   * GET /api/v1/admin/cluster/outage-impact
   *
   * `read_only` is included: this is diagnostic information an on-call
   * operator needs before they have (or want) write access.
   */
  app.get('/admin/cluster/outage-impact', {
    onRequest: [requireRole('super_admin', 'admin', 'support', 'read_only')],
    schema: {
      tags: ['Cluster'],
      summary: 'Nodes currently down and which tenants they affect',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const now = Date.now();
    if (cached && now - cached.at < CACHE_TTL_MS) return success(cached.value);

    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as
      string | undefined;

    let impact: ClusterOutageImpact;
    try {
      const k8s = createK8sClients(kubeconfigPath);
      const facts = await collectFacts(app.db, k8s);
      impact = computeOutageImpact({ ...facts, observedAt: new Date() });
    } catch (err) {
      // Never surface an empty-and-therefore-reassuring result on failure.
      // The UI renders readError instead of a green "no outage" state.
      impact = {
        nodesDown: [],
        affectedTenants: [],
        affectedTenantCount: 0,
        downTenantCount: 0,
        degradedTenantCount: 0,
        mailAffected: false,
        observedAt: new Date().toISOString(),
        readError: (err as Error).message ?? 'cluster read failed',
      };
    }

    // Only cache a clean read — an error should retry on the next poll
    // rather than persist for 15 s.
    if (!impact.readError) cached = { at: now, value: impact };
    return success(impact);
  });

  /**
   * POST /api/v1/admin/tenants/:id/recover/repin
   *
   * Move a tenant off a node (or clear its pin entirely). This is the one
   * recovery the degraded-tenant wizard performs directly: it moves no data,
   * is reversible, and is the same operation the drain flow already applies
   * per tenant.
   *
   * It is NOT gated on the tenant being degraded — an operator rebalancing a
   * healthy tenant is a legitimate use, and refusing would send them to the
   * drain modal to achieve the same thing by a longer route.
   */
  app.post('/admin/tenants/:id/recover/repin', {
    onRequest: [requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Tenants'],
      summary: 'Re-pin a tenant to another node, or clear its pin',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = tenantRepinRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
        { field: first.path.join('.') },
      );
    }
    const { targetNode, reason } = parsed.data;

    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);

    const { tenants } = await import('../../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [tenant] = await app.db
      .select({ id: tenants.id, ns: tenants.kubernetesNamespace, pin: tenants.nodeName })
      .from(tenants)
      .where(eq(tenants.id, id));
    if (!tenant) throw new ApiError('TENANT_NOT_FOUND', `Tenant '${id}' not found`, 404);

    // Refuse a target that does not exist, rather than writing a pin the
    // cluster can never satisfy — the tenant would go from degraded to
    // permanently unschedulable.
    if (targetNode !== '') {
      try {
        await k8s.core.readNode({ name: targetNode });
      } catch {
        throw new ApiError(
          'NODE_NOT_FOUND',
          `Target node '${targetNode}' is not in the cluster — refusing to pin a tenant to it.`,
          400,
          { node_name: targetNode },
        );
      }
    }

    const { buildDrainImpact, repinTenantPlacement, makeLonghornHostTagEnsurer } =
      await import('../nodes/service.js');

    // Derive the tenant's workloads + volumes from wherever it is pinned now.
    // With no pin there is nothing for buildDrainImpact to report, so an
    // explicit error beats a silent no-op that looks like success.
    const releaseFrom = tenant.pin ?? '';
    if (!releaseFrom) {
      throw new ApiError(
        'TENANT_NOT_PINNED',
        'This tenant has no node pin, so there is nothing to move. Its workloads are already placed by the scheduler.',
        409,
      );
    }
    const impact = await buildDrainImpact(k8s, app.db, releaseFrom);
    const pinned = impact.pinnedTenants.find((p) => p.tenantId === id);
    if (!pinned) {
      throw new ApiError(
        'TENANT_NOT_PINNED',
        `Tenant is recorded as pinned to '${releaseFrom}' but no workloads or volumes there reference it.`,
        409,
      );
    }

    const counts = await repinTenantPlacement(
      k8s, app.db,
      { tenantId: id, namespace: pinned.namespace, workloads: pinned.workloads, pvcs: pinned.pvcs },
      targetNode,
      releaseFrom,
      makeLonghornHostTagEnsurer(k8s),
    );

    try {
      const { auditLogs } = await import('../../db/schema.js');
      const crypto = await import('node:crypto');
      await app.db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorId: request.user?.sub ?? 'system',
        actorType: 'user',
        actionType: 'tenant.repin',
        resourceType: 'tenant',
        resourceId: id,
        changes: {
          reason,
          from: releaseFrom,
          to: targetNode === '' ? null : targetNode,
          workloadsPatched: counts.workloads,
          volumesPatched: counts.pvcs,
        } as unknown as Record<string, unknown>,
      });
    } catch (err) {
      app.log.warn({ err }, 'tenant repin audit insert failed');
    }

    // Invalidate the cached impact so the banner and list reflect the change
    // on the operator's next poll instead of up to 15s later.
    resetOutageImpactCache();

    return success({
      tenantId: id,
      targetNode: targetNode === '' ? null : targetNode,
      workloadsPatched: counts.workloads,
      volumesPatched: counts.pvcs,
    });
  });
}
