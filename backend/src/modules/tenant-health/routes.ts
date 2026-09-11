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
}
