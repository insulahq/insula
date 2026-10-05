/**
 * The scenario list of Malicious Traffic Detection: a filter row and one
 * table row per scenario the agent has loaded, each with its Bans /
 * Alert-only switch.
 *
 * Column alignment is explicit on BOTH the header and the cells. A bare <th>
 * is centred by the browser while the cells were left- or right-aligned, so
 * every heading sat visibly off its column. The table is `table-fixed` with a
 * colgroup so the columns keep the same widths whatever the filter leaves on
 * screen.
 */
import { useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import SortableHeader from '@/components/ui/SortableHeader';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { useSortable } from '@/hooks/use-sortable';
import { useSetScenarioSimulation } from '@/hooks/use-crowdsec';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { CrowdsecScenario } from '@insula/api-contracts';

interface ScenarioTableProps {
  readonly scenarios: readonly CrowdsecScenario[];
  readonly isLoading: boolean;
  /** False while Malicious Traffic Detection is disabled on the agent. */
  readonly detectionRunning: boolean;
}

/** Shared by each heading and its cells so the two cannot drift apart. */
const ALIGN = {
  name: 'text-left',
  description: 'text-left',
  eventsPoured: 'text-right',
  alertsRaised: 'text-right',
  simulated: 'text-left',
} as const;

export default function ScenarioTable({ scenarios, isLoading, detectionRunning }: ScenarioTableProps) {
  const mutate = useSetScenarioSimulation();
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const debouncedQ = useDebouncedValue(q, 300);
  const [pending, setPending] = useState<string | null>(null);

  // Filter BEFORE sorting so the shared hook sorts what is actually on screen.
  const filtered = useMemo(() => {
    const needle = debouncedQ.trim().toLowerCase();
    return scenarios.filter((s) => {
      if (onlyActive && s.eventsPoured === 0) return false;
      if (!needle) return true;
      return s.name.toLowerCase().includes(needle)
        || s.description.toLowerCase().includes(needle);
    });
  }, [scenarios, debouncedQ, onlyActive]);

  // Default to the busiest scenarios: on a 53-row list the ones raising alerts
  // are the only ones an operator has a decision to make about.
  const { sortedData: rows, sortKey, sortDirection, onSort } =
    useSortable<CrowdsecScenario>(filtered, 'alertsRaised', 'desc');

  const toggle = (s: CrowdsecScenario) => {
    setPending(s.name);
    mutate.mutate({ name: s.name, simulated: !s.simulated }, {
      onSettled: () => setPending(null),
    });
  };

  const header = (label: string, key: keyof typeof ALIGN) => (
    <SortableHeader
      label={label}
      sortKey={key}
      currentKey={sortKey}
      direction={sortDirection}
      onSort={onSort}
      className={ALIGN[key]}
    />
  );

  return (
    <div className="space-y-3">
      {mutate.isError && (
        <ErrorPanel error={extractOperatorError(mutate.error)} compact testId="scenario-toggle-error" />
      )}
      {mutate.data?.data?.rollError && (
        <p className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          Saved, but the agent could not be rolled ({mutate.data.data.rollError}). The change
          applies when the agent next restarts.
        </p>
      )}
      {!detectionRunning && (
        <p className="text-xs text-gray-600 dark:text-gray-400" data-testid="scenarios-disabled-note">
          Detection is disabled, so every scenario is alert-only right now. The modes below are
          your per-scenario choices — they apply again when you enable it.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by name or description"
            className="w-64 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 py-1 pl-7 pr-2 text-xs text-gray-900 dark:text-gray-100"
            data-testid="scenarios-filter"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => setOnlyActive(e.target.checked)}
            data-testid="scenarios-only-active"
          />
          Only scenarios that have seen traffic
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] table-fixed text-sm" data-testid="scenarios-table">
          <colgroup>
            <col className="w-[30%]" />
            <col />
            <col className="w-28" />
            <col className="w-28" />
            <col className="w-36" />
          </colgroup>
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-[10px] uppercase text-gray-600 dark:text-gray-400">
            <tr>
              {header('Scenario', 'name')}
              {header('What it detects', 'description')}
              {header('Events', 'eventsPoured')}
              {header('Alerts', 'alertsRaised')}
              {header('Mode', 'simulated')}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {isLoading && (
              <tr><td colSpan={5} className="px-5 py-6 text-center text-xs text-gray-500 dark:text-gray-400">Loading scenarios…</td></tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
                  {scenarios.length === 0
                    ? 'No scenarios reported — is the crowdsec-agent DaemonSet running?'
                    : 'No scenarios match the filter.'}
                </td>
              </tr>
            )}
            {rows.map((s) => (
              <ScenarioRow
                key={s.name}
                s={s}
                pending={pending === s.name}
                detectionRunning={detectionRunning}
                onToggle={() => toggle(s)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-gray-500 dark:text-gray-400">
        Event and alert counts are since the agent last started, not lifetime totals. Changing a
        mode rewrites the agent's simulation config and restarts it — CrowdSec reads that file
        only at startup, so nothing takes effect until it does.
      </p>
    </div>
  );
}

function ScenarioRow({ s, pending, detectionRunning, onToggle }: {
  readonly s: CrowdsecScenario;
  readonly pending: boolean;
  readonly detectionRunning: boolean;
  readonly onToggle: () => void;
}) {
  const hint = !detectionRunning
    ? 'Detection is disabled, so this scenario is alert-only right now. This choice applies when it is enabled again — click to change it.'
    : s.simulated
      ? 'Alert-only. Click to let this scenario issue bans.'
      : 'Issuing bans. Click to make it alert-only.';
  return (
    <tr data-testid={`scenario-row-${s.name}`}>
      <td className={`px-5 py-2 align-top break-words font-mono text-[11px] text-gray-900 dark:text-gray-100 ${ALIGN.name}`}>{s.name}</td>
      <td className={`px-5 py-2 align-top text-xs text-gray-600 dark:text-gray-400 ${ALIGN.description}`}>{s.description || '—'}</td>
      <td className={`px-5 py-2 align-top font-mono tabular-nums text-[11px] text-gray-700 dark:text-gray-300 ${ALIGN.eventsPoured}`}>
        {s.eventsPoured.toLocaleString()}
      </td>
      <td className={`px-5 py-2 align-top font-mono tabular-nums text-[11px] text-gray-700 dark:text-gray-300 ${ALIGN.alertsRaised}`}>
        {s.alertsRaised.toLocaleString()}
      </td>
      <td className={`px-5 py-2 align-top ${ALIGN.simulated}`}>
        <button
          type="button"
          onClick={onToggle}
          disabled={pending}
          title={hint}
          data-testid={`scenario-toggle-${s.name}`}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50 ${
            detectionRunning ? '' : 'opacity-60'
          } ${
            s.simulated
              ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60'
              : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:hover:bg-emerald-900/60'
          }`}
        >
          {pending && <Loader2 size={10} className="animate-spin" />}
          {s.simulated ? 'Alert only' : 'Bans'}
        </button>
      </td>
    </tr>
  );
}
