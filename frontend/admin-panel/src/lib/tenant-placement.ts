import type { TenantPlacementSummary } from '@insula/api-contracts';

/**
 * Where an Auto tenant is now: the Kubernetes names of the nodes it runs on,
 * else holds its data, as the placement reconciler last saw them. [] until it
 * has been seen. The Placement cell shows it as `auto (<node>)`, and the sort
 * and the search follow what the cell shows. Pure.
 *
 * The `unknown` skip matches the server only because an `unknown` row never
 * carries nodes (the reconciler's store does not let an incomplete read
 * overwrite known facts, and a first-seen `unknown` row has none). The search
 * and the Active placement filter read actual_nodes without that check: keep
 * the two in step if that ever changes.
 */
export function autoCurrentNodes(placement: TenantPlacementSummary | null | undefined): readonly string[] {
  if (!placement || placement.status === 'unknown') return [];
  return placement.actualNodes;
}
