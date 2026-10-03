import type { TenantPlacementSummary } from '@insula/api-contracts';
import { useNodeLabel, useNodeText } from '@/hooks/use-node-labels';

interface PlacementCellProps {
  /** `tenants.node_name` — the primary node ("primary data location"). */
  readonly nodeName: string | null | undefined;
  readonly placement: TenantPlacementSummary | null | undefined;
}

/**
 * The tenants-table Placement column.
 *
 * Normally the primary node (or "auto"). When the tenant is NOT on its primary
 * node — after a storage failover, a node outage, or a pod scheduled elsewhere
 * — it shows where the tenant ACTUALLY is, in red, with the primary node
 * underneath: the column must not keep claiming a node the tenant left.
 */
export default function PlacementCell({ nodeName, placement }: PlacementCellProps) {
  const nodeLabel = useNodeLabel();
  const nodeText = useNodeText();
  if (placement?.status === 'misplaced') {
    const actual = placement.actualNodes.length > 0 ? placement.actualNodes.map((n) => nodeLabel(n)).join(', ') : 'unknown';
    const primaryName = placement.primaryNode ?? nodeName ?? null;
    const primary = primaryName ? nodeLabel(primaryName) : '—';
    const why = placement.reasons.length > 0 ? ` — ${nodeText(placement.reasons.join(', '))}` : '';
    return (
      <span
        className="flex flex-col"
        title={`Not on its primary node ${primary}${why}`}
        data-testid="placement-misplaced"
      >
        <span className="font-mono font-semibold text-red-600 dark:text-red-400">{actual}</span>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">primary {primary}</span>
      </span>
    );
  }

  if (nodeName) {
    const label = nodeLabel(nodeName);
    return (
      <span
        className="font-mono text-gray-700 dark:text-gray-300"
        title={label === nodeName ? `Pinned to node ${nodeName}` : `Pinned to node ${label} (${nodeName})`}
      >
        {label}
      </span>
    );
  }

  // Not pinned is NOT the same as unknown. A bare "—" read as missing data,
  // which is what the column actually showed for everyone while nodeName was
  // being stripped by the response schema.
  return (
    <span
      className="italic text-gray-500 dark:text-gray-400"
      title="No node pin — the Kubernetes scheduler places this tenant's workloads"
    >
      auto
    </span>
  );
}
