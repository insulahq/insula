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
import {
  tenantRepinRequestSchema,
  failbackAcknowledgeRequestSchema,
} from '@insula/api-contracts';
import type { ClusterOutageImpact, FailbackReview } from '@insula/api-contracts';
import {
  selectFailbackReviewItems,
  returnedNodesFrom,
  PLACEMENT_AUDIT_ACTIONS,
  FAILBACK_ACK_ACTION,
} from './failback.js';
import { tenants as tenantsTable, auditLogs } from '../../db/schema.js';
import { inArray, desc, eq } from 'drizzle-orm';
import crypto from 'node:crypto';

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
        degradedServices: [],
        nodesAsOf: null,
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
          strandedPodsEvicted: counts.evictedPods,
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

  /**
   * GET /api/v1/admin/cluster/failback-review
   *
   * What is still displaced from a node that has since come back. Derived from
   * the placement audit rows rather than a table of its own — see failback.ts.
   * Deliberately NOT cached with the outage impact: it is polled from one panel
   * on demand, not from every admin page, and it must reflect an acknowledgement
   * immediately or the operator will click it twice.
   */
  app.get('/admin/cluster/failback-review', {
    onRequest: [requireRole('super_admin', 'admin', 'support', 'read_only')],
    schema: {
      tags: ['Cluster'],
      summary: 'Tenants still displaced from a node that has come back online',
      security: [{ bearerAuth: [] }],
    },
  }, async (): Promise<{ data: FailbackReview }> => {
    const observedAt = new Date().toISOString();
    const errors: string[] = [];

    let readyNodes = new Set<string>();
    try {
      const k8s = createK8sClients();
      const resp = await k8s.core.listNode() as {
        items?: Array<{
          metadata?: { name?: string };
          status?: { conditions?: Array<{ type?: string; status?: string }> };
        }>;
      };
      readyNodes = new Set(
        (resp.items ?? [])
          .filter((n) => (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'))
          .map((n) => n.metadata?.name ?? '')
          .filter(Boolean),
      );
    } catch (err) {
      errors.push(`nodes: ${(err as Error).message ?? 'read failed'}`);
    }

    let rows: Array<{
      tenantId: string; actionType: string; createdAt: Date; changes: Record<string, unknown> | null;
    }> = [];
    let tenantFacts: Array<{
      tenantId: string; tenantName: string; currentNode: string | null; storageTier: string;
    }> = [];
    try {
      // Newest first, bounded: a review only needs each tenant's latest
      // placement event, and an unbounded scan of the audit table during an
      // outage is exactly the wrong time to be slow.
      const raw = await app.db
        .select({
          resourceId: auditLogs.resourceId,
          actionType: auditLogs.actionType,
          createdAt: auditLogs.createdAt,
          changes: auditLogs.changes,
        })
        .from(auditLogs)
        .where(inArray(auditLogs.actionType, [...PLACEMENT_AUDIT_ACTIONS]))
        .orderBy(desc(auditLogs.createdAt))
        .limit(500);
      rows = raw
        .filter((r) => !!r.resourceId)
        .map((r) => ({
          tenantId: r.resourceId as string,
          actionType: r.actionType,
          createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string),
          changes: (r.changes ?? null) as Record<string, unknown> | null,
        }));

      const ids = [...new Set(rows.map((r) => r.tenantId))];
      if (ids.length > 0) {
        const trows = await app.db
          .select({
            id: tenantsTable.id,
            name: tenantsTable.name,
            nodeName: tenantsTable.nodeName,
            tier: tenantsTable.storageTier,
          })
          .from(tenantsTable)
          .where(inArray(tenantsTable.id, ids));
        tenantFacts = trows.map((t) => ({
          tenantId: t.id,
          tenantName: t.name,
          currentNode: t.nodeName ?? null,
          storageTier: String(t.tier ?? 'local'),
        }));
      }
    } catch (err) {
      errors.push(`placement history: ${(err as Error).message ?? 'read failed'}`);
    }

    const items = selectFailbackReviewItems({ rows, tenants: tenantFacts, readyNodes });
    return success({
      returnedNodes: returnedNodesFrom(items),
      items,
      observedAt,
      readError: errors.length > 0 ? errors.join('; ') : null,
    });
  });

  /**
   * POST /api/v1/admin/tenants/:id/failback/acknowledge
   *
   * Records that the operator has decided the current placement is fine. This
   * moves NO data — it writes the audit row that ends the review, which is why
   * it takes a reason: six months later the row has to explain itself.
   */
  app.post<{ Params: { id: string } }>('/admin/tenants/:id/failback/acknowledge', {
    onRequest: [requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Cluster'],
      summary: 'Accept a tenant\'s current placement and close its failback review',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { id } = request.params;
    const parsed = failbackAcknowledgeRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'A reason of at least 3 characters is required so the decision is explainable later.',
        400,
      );
    }

    const [tenant] = await app.db
      .select({ id: tenantsTable.id, name: tenantsTable.name, nodeName: tenantsTable.nodeName })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, id));
    if (!tenant) throw new ApiError('TENANT_NOT_FOUND', 'No such tenant.', 404);

    await app.db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorId: request.user?.sub ?? 'system',
      actorType: 'user',
      actionType: FAILBACK_ACK_ACTION,
      resourceType: 'tenant',
      resourceId: id,
      changes: {
        reason: parsed.data.reason,
        acceptedPlacement: tenant.nodeName ?? null,
      } as unknown as Record<string, unknown>,
    });

    return success({ tenantId: id, acknowledged: true });
  });
}
