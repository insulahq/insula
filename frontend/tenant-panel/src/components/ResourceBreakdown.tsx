import { useMemo } from 'react';
import { AlertTriangle, Info, Pin } from 'lucide-react';
import { useResourceBreakdown, type ResourceBreakdown as Breakdown } from '@/hooks/use-deployments';
import { useResourceAvailability as useTenantCpuModel } from '@/hooks/use-resource-availability';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

interface ResourceBreakdownProps {
  readonly tenantId: string;
  readonly deploymentId: string;
}

const QUANTITY_SUFFIX: Readonly<Record<string, number>> = {
  '': 1, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
};

/** A Kubernetes quantity ("450m", "1.5", "512Mi") as a plain number, so "1Gi" sorts above "900Mi". */
function quantityValue(quantity: string): number | null {
  const match = /^([0-9]*\.?[0-9]+)([a-zA-Z]*)$/.exec(quantity.trim());
  const factor = match ? QUANTITY_SUFFIX[match[2]] : undefined;
  return match && factor !== undefined ? Number(match[1]) * factor : null;
}

const NO_COMPONENTS: Breakdown['components'] = [];

/**
 * ADR-037 surface: shows how the deployment-level CPU/memory budget is
 * split across the app's components. Renders as a compact table:
 *
 *   web    weight 50    450m CPU    450Mi memory
 *   db     weight 35    330m CPU    332Mi memory
 *   ...
 *
 * Pinned components (Jobs, hard-coded resources) render with a pin icon
 * and a tooltip explaining they don't share the budget.
 */
export function ResourceBreakdown({ tenantId, deploymentId }: ResourceBreakdownProps) {
  const { data, isLoading, isError, error } = useResourceBreakdown(tenantId, deploymentId);
  // Under the tier model the per-component CPU figure is a split of the
  // application's SHARE, not a baseline it is guaranteed — ADR-062. The
  // word matters: "baseline" told the tenant a number was reserved for
  // them, and nothing ever was.
  const { data: tenantCpuData } = useTenantCpuModel(tenantId);
  const tieredCpu = tenantCpuData?.data?.cpuModel === 'tiered';
  // Before the early returns (Rules of Hooks). Manifest order carries no
  // meaning, so by name; CPU and memory sort by quantity, not by their text.
  const components = data?.data?.components ?? NO_COMPONENTS;
  const sortableComponents = useMemo(() => components.map((c) => ({
    ...c,
    weightValue: c.pinned ? null : c.weight,
    cpuValue: quantityValue(c.cpu),
    memoryValue: quantityValue(c.memory),
  })), [components]);
  const { sortedData: sortedComponents, sortKey, sortDirection, onSort } = useSortable(sortableComponents, 'name');
  const th = { currentKey: sortKey, direction: sortDirection, onSort };

  if (isLoading) {
    return <div className="text-xs text-gray-400 dark:text-gray-500">Loading breakdown…</div>;
  }

  if (isError) {
    const msg = error instanceof Error ? error.message : 'Failed to load breakdown';
    return <div className="text-xs text-red-500 dark:text-red-400">{msg}</div>;
  }

  if (!data?.data) return null;

  const breakdown = data.data;

  if (breakdown.components.length <= 1) {
    // Single-component apps don't need a breakdown — the deployment total
    // IS the component's allocation. Hide the panel entirely.
    return null;
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">
          Per-component allocation
        </h4>
        <span
          className="text-[10px] text-gray-400 dark:text-gray-500"
          title={tieredCpu
            ? 'CPU is a share of the machine under contention, split across components by weight; memory is guaranteed at the declared value.'
            : 'CPU bursts beyond the baseline when neighbours are idle; memory is guaranteed at the declared value.'}
        >
          {tieredCpu ? 'CPU shared · Memory guaranteed' : 'CPU burstable · Memory guaranteed'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 dark:text-gray-400">
              <SortableHeader label="Component" sortKey="name" {...th} className="!pl-0 !pr-2 !pt-0 !pb-1 font-normal" />
              <SortableHeader label="Weight" sortKey="weightValue" {...th} className="!px-2 !pt-0 !pb-1 font-normal text-right" />
              <SortableHeader label={tieredCpu ? 'CPU share' : 'CPU baseline'} sortKey="cpuValue" {...th} className="!px-2 !pt-0 !pb-1 font-normal text-right" />
              <SortableHeader label="Memory" sortKey="memoryValue" {...th} className="!pl-2 !pr-0 !pt-0 !pb-1 font-normal text-right" />
            </tr>
          </thead>
          <tbody>
            {sortedComponents.map((c) => (
              <tr
                key={c.name}
                className="border-t border-gray-200 dark:border-gray-700/50 text-gray-700 dark:text-gray-300"
              >
                <td className="py-1 pr-2 font-mono flex items-center gap-1">
                  {c.pinned && (
                    <Pin
                      size={10}
                      className="text-gray-400"
                    />
                  )}
                  <span title={c.pinned ? 'Hard-pinned — does not share the deployment budget' : undefined}>
                    {c.name}
                  </span>
                </td>
                <td className="py-1 px-2 text-right text-gray-500 dark:text-gray-400">
                  {c.pinned ? '—' : (c.weight ?? 'even')}
                </td>
                <td className="py-1 px-2 text-right font-mono">{c.cpu}</td>
                <td className="py-1 pl-2 text-right font-mono">{c.memory}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 font-medium">
              <td className="pt-1 pr-2">Total</td>
              <td className="pt-1 px-2"></td>
              <td className="pt-1 px-2 text-right font-mono">{breakdown.total.cpu}</td>
              <td className="pt-1 pl-2 text-right font-mono">{breakdown.total.memory}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {breakdown.warnings.length > 0 && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 dark:bg-amber-900/20 px-2 py-1.5">
          <AlertTriangle
            size={12}
            className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
          />
          <ul className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
            {breakdown.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-2 flex items-start gap-1 text-[10px] text-gray-400 dark:text-gray-500">
        <Info size={10} className="mt-0.5 shrink-0" />
        <span>
          Components share the deployment&apos;s CPU/memory budget by weight, with a per-component minimum floor.
          {tieredCpu
            ? ' CPU is a share under contention, not a reservation; memory is guaranteed at the declared value.'
            : ' CPU may burst above the baseline; memory is guaranteed at the declared value.'}
        </span>
      </p>
    </div>
  );
}
