/**
 * Stored placement rows → the `@insula/api-contracts` shapes. Pure.
 */
import type {
  TenantPlacement, TenantPlacementSummary, TenantStorageFailover,
} from '@insula/api-contracts';
import type { StoredFailover, StoredPlacement } from './store.js';

export function presentPlacementSummary(p: StoredPlacement): TenantPlacementSummary {
  return {
    status: p.status,
    primaryNode: p.primaryNode,
    actualNodes: [...p.actualNodes],
    reasons: [...p.reasons],
    misplacedSince: p.misplacedSince?.toISOString() ?? null,
    checkedAt: p.checkedAt.toISOString(),
  };
}

export function presentPlacement(p: StoredPlacement): TenantPlacement {
  return {
    ...presentPlacementSummary(p),
    storageTier: p.storageTier,
    workloadNodes: [...p.workloadNodes],
    attachedNodes: [...p.attachedNodes],
    dataNodes: [...p.dataNodes],
  };
}

export function presentFailover(f: StoredFailover): TenantStorageFailover {
  return {
    id: f.id,
    volumeName: f.volumeName,
    pvcName: f.pvcName,
    remountRequestedAt: f.remountRequestedAt.toISOString(),
    nodesBefore: [...f.nodesBefore],
    nodesAfter: [...f.nodesAfter],
    detectedAt: f.detectedAt.toISOString(),
  };
}
