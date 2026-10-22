/**
 * Which tenants a node takes — its tenant hosting mode.
 *
 *   all    — any tenant. Auto placement (a new tenant, a drain's Auto) may
 *            pick it.
 *   pinned — only tenants an operator places here: a remote node, or one kept
 *            for particular customers. Auto never picks it, and its
 *            PreferNoSchedule taint makes Kubernetes place tenant pods that
 *            are not pinned here elsewhere whenever another node fits.
 *   none   — no tenants: "Can host tenant workloads" off.
 *
 * Kept as two node labels. `host-tenant-workloads` stays true/false exactly as
 * before, so bootstrap, node sync and an older API read it unchanged (an older
 * API sees a pinned-only node as one that takes tenants, its old meaning).
 * `tenant-placement=pinned` narrows it. Turning hosting off — a drain does
 * that — only flips the first, so letting tenants back returns the node to
 * pinned-only rather than to all.
 *
 * An HA-tier tenant cannot live on a pinned-only node. Its pin is a
 * preference, not a rule (it fails over to any node holding a replica), and
 * the taint outweighs that preference, so it would leave the node the next
 * time its pod is rescheduled. Refusing it says so up front instead.
 */
import { eq, and } from 'drizzle-orm';
import type { NodeTenantHosting } from '@insula/api-contracts';
import { clusterNodes, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';

export const TENANT_PLACEMENT_LABEL = 'insula.host/tenant-placement';
export const TENANT_PLACEMENT_PINNED = 'pinned';
export const PINNED_ONLY_TAINT_KEY = 'insula.host/pinned-tenants-only';

export interface NodeHostingFacts {
  readonly canHostTenantWorkloads: boolean;
  /** The node's labels as node sync stored them (JSONB). */
  readonly labels?: unknown;
}

function labelOf(labels: unknown, key: string): string | undefined {
  if (labels === null || typeof labels !== 'object') return undefined;
  const v = (labels as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

export function tenantHostingOf(node: NodeHostingFacts): NodeTenantHosting {
  if (!node.canHostTenantWorkloads) return 'none';
  return labelOf(node.labels, TENANT_PLACEMENT_LABEL) === TENANT_PLACEMENT_PINNED ? 'pinned' : 'all';
}

/** May the platform choose this node on its own? Only an `all` node. */
export function takesAutoPlacedTenants(node: NodeHostingFacts): boolean {
  return tenantHostingOf(node) === 'all';
}

export function haOnPinnedOnlyError(nodeName: string, tenantName: string | null): ApiError {
  return new ApiError(
    'NODE_PINNED_TENANTS_ONLY',
    `'${nodeName}' takes pinned tenants only, and ${tenantName ?? 'this tenant'} is on the HA storage tier, which `
      + 'is not held to one node. Use the Local tier for a tenant on this node, or pick another node.',
    409,
    {
      node_name: nodeName,
      operatorError: {
        code: 'NODE_PINNED_TENANTS_ONLY',
        title: 'HA-tier tenants cannot be placed on a pinned-only node',
        detail: `${tenantName ?? 'This tenant'} is on the HA storage tier. An HA-tier tenant fails over to any node holding a copy of its `
          + `data, and Kubernetes keeps tenant pods off '${nodeName}' unless they are hard-pinned there, so it `
          + 'would leave the node the next time its pod restarts.',
        remediation: [
          'Switch the tenant to the Local storage tier, then place it on this node.',
          'Or pick a node whose Tenant hosting is set to all tenants.',
        ],
        retryable: false,
        diagnostics: { nodeName, storageTier: 'ha' },
      },
    },
  );
}

/**
 * Refuse an HA-tier tenant on a pinned-only node. A no-op for any other tier,
 * an unset node, or a node the inventory does not know (the caller's own
 * existence check reports that).
 */
export async function assertNodeTakesTier(
  db: Database,
  nodeName: string | null | undefined,
  tier: string | null | undefined,
  tenantName: string | null = null,
): Promise<void> {
  if (!nodeName || tier !== 'ha') return;
  const [node] = await db.select({
    canHostTenantWorkloads: clusterNodes.canHostTenantWorkloads,
    labels: clusterNodes.labels,
  }).from(clusterNodes).where(eq(clusterNodes.name, nodeName)).limit(1);
  if (node && tenantHostingOf(node) === 'pinned') throw haOnPinnedOnlyError(nodeName, tenantName);
}

/** HA-tier tenants pinned to `nodeName` — what blocks making it pinned-only. */
export async function haTenantsPinnedTo(db: Database, nodeName: string): Promise<string[]> {
  const rows = await db.select({ name: tenants.name })
    .from(tenants)
    .where(and(eq(tenants.nodeName, nodeName), eq(tenants.storageTier, 'ha')));
  return rows.map((r) => r.name).sort();
}
