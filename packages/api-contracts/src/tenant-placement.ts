import { z } from 'zod';

/**
 * Tenant placement — where a tenant actually runs and keeps its data, compared
 * with its primary node (`tenants.node_name`, the "primary data location").
 * Written every minute by the placement reconciler.
 *
 *   placed     everything is on the primary node
 *   misplaced  workloads, the attached volume or the data are elsewhere —
 *              `actualNodes` says where, `reasons` says what
 *   unpinned   no primary node, nothing to compare against
 *   unknown    not yet observed, or the last cluster read was incomplete
 */
export const placementStatusEnum = z.enum(['placed', 'misplaced', 'unpinned', 'unknown']);
export type PlacementStatus = z.infer<typeof placementStatusEnum>;

/** The slice the tenants table needs, on every list row. */
export const tenantPlacementSummarySchema = z.object({
  status: placementStatusEnum,
  primaryNode: z.string().nullable(),
  /** Where the tenant is now: where it runs, else where its data is. */
  actualNodes: z.array(z.string()),
  /** Why it is misplaced, e.g. "running on node-b", "data on node-b". */
  reasons: z.array(z.string()),
  misplacedSince: z.string().nullable(),
  checkedAt: z.string(),
});
export type TenantPlacementSummary = z.infer<typeof tenantPlacementSummarySchema>;

export const tenantPlacementSchema = tenantPlacementSummarySchema.extend({
  storageTier: z.enum(['local', 'ha']),
  /** Nodes running the tenant's long-lived pods. */
  workloadNodes: z.array(z.string()),
  /** Nodes its volumes are attached to. */
  attachedNodes: z.array(z.string()),
  /** Nodes holding a usable replica of its volumes. */
  dataNodes: z.array(z.string()),
});
export type TenantPlacement = z.infer<typeof tenantPlacementSchema>;

/** A Longhorn salvage of one of the tenant's volumes. */
export const tenantStorageFailoverSchema = z.object({
  id: z.string(),
  volumeName: z.string(),
  pvcName: z.string().nullable(),
  /** Longhorn `status.remountRequestedAt` — when the volume was salvaged. */
  remountRequestedAt: z.string(),
  /** Where the tenant was on the check before the salvage was seen. */
  nodesBefore: z.array(z.string()),
  /** Where it was when the salvage was first seen (empty while restarting). */
  nodesAfter: z.array(z.string()),
  detectedAt: z.string(),
});
export type TenantStorageFailover = z.infer<typeof tenantStorageFailoverSchema>;

/** GET /api/v1/tenants/:id/placement */
export const tenantPlacementDetailSchema = z.object({
  placement: tenantPlacementSchema.nullable(),
  failovers: z.array(tenantStorageFailoverSchema),
});
export type TenantPlacementDetail = z.infer<typeof tenantPlacementDetailSchema>;

export const tenantPlacementDetailResponseSchema = z.object({ data: tenantPlacementDetailSchema });
export type TenantPlacementDetailResponse = z.infer<typeof tenantPlacementDetailResponseSchema>;
