/**
 * Traffic detection — the second ban engine, which until now had no UI at all.
 *
 * The WAF auto-ban scheduler had a settings card; the CrowdSec scenarios that
 * produce the OTHER half of the bans had a number on a status tile and nothing
 * else. An operator looking at `crowdsecurity/http-sensitive-files` in the ban
 * table could not find out what it does, how much traffic it sees, or how to
 * stop it banning.
 *
 * The counters are real (`cscli metrics show scenarios` on the agent) and reset
 * when the agent restarts, which the header says rather than implying a total.
 */
import { useMemo, useState } from 'react';
import { Activity, AlertTriangle, FileText, Loader2, Search } from 'lucide-react';
import SortableHeader from '@/components/ui/SortableHeader';
import { useSortable } from '@/hooks/use-sortable';
import { useCrowdsecScenarios, useSetScenarioSimulation } from '@/hooks/use-crowdsec';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { CrowdsecScenario } from '@insula/api-contracts';

export default function ScenariosCard() {
  const { data, isLoading, isError, error } = useCrowdsecScenarios();
  const mutate = useSetScenarioSimulation();
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const debouncedQ = useDebouncedValue(q, 300);
  const [pending, setPending] = useState<string | null>(null);

  const payload = data?.data;
  const scenarios = payload?.scenarios ?? [];

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

  const simulatedCount = scenarios.filter((s) => s.simulated).length;
  const activeCount = scenarios.filter((s) => s.eventsPoured > 0).length;

  const toggle = (s: CrowdsecScenario) => {
    setPending(s.name);
    mutate.mutate({ name: s.name, simulated: !s.simulated }, {
      onSettled: () => setPending(null),
    });
  };

  return (
    <section
      className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4"
      data-testid="crowdsec-scenarios-card"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Activity size={15} /> Traffic detection
          </h3>
          <p className="mt-1 max-w-3xl text-xs text-gray-600 dark:text-gray-400">
            Behaviour patterns the log-processing agent watches for in the ingress access log.
            These produce the <strong>Auto · Traffic</strong> bans in the Banned IPs tab — a
            separate engine from the WAF auto-ban scheduler above, which reacts to ModSecurity
            rule hits instead. <strong>Simulated</strong> scenarios still raise alerts but issue
            no ban.
          </p>
        </div>
        <div className="text-right text-[11px] text-gray-500 dark:text-gray-400">
          <div>{scenarios.length} loaded · {simulatedCount} simulated</div>
          <div>{activeCount} have seen traffic</div>
        </div>
      </header>

      {payload?.logSources && payload.logSources.length > 0 && (
        <div
          className="mt-3 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-3 py-2 text-[11px] text-gray-600 dark:text-gray-400"
          data-testid="crowdsec-log-sources"
        >
          <span className="inline-flex items-center gap-1 font-medium text-gray-700 dark:text-gray-300">
            <FileText size={12} /> Log sources
          </span>
          <ul className="mt-1 space-y-0.5 font-mono">
            {payload.logSources.map((src) => (
              <li key={`${src.type}:${src.source}`}>{src.source} <span className="opacity-60">({src.type})</span></li>
            ))}
          </ul>
          {/* Without this line a dozen SSH scenarios sitting at zero events read
              as broken detection. They are not — there is no SSH log source on
              this agent, and saying which sources exist is honest where
              computing a per-scenario "can this fire?" verdict would be a guess. */}
          <p className="mt-1.5 not-italic">
            A scenario can only fire on events one of these sources produces. Scenarios that
            arrived as hub dependencies for other log types will sit at zero events — that is
            expected, not a fault.
          </p>
        </div>
      )}

      {payload?.globalSimulation && (
        <p
          className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
          data-testid="crowdsec-global-simulation"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            <strong>Global simulation is ON.</strong> Every scenario is alert-only regardless of
            the per-row setting below, so traffic detection is issuing no bans at all.
          </span>
        </p>
      )}

      {isError && (
        <p className="mt-3 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-800 dark:text-red-200">
          Could not load scenarios: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      )}
      {payload?.error && (
        <p
          className="mt-3 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-800 dark:text-red-200"
          data-testid="crowdsec-scenarios-error"
        >
          Could not reach the CrowdSec agent: {payload.error}
        </p>
      )}
      {mutate.isError && (
        <p className="mt-3 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-800 dark:text-red-200">
          {mutate.error instanceof Error ? mutate.error.message : 'Could not change the scenario'}
        </p>
      )}
      {mutate.data?.data?.rollError && (
        <p className="mt-3 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          Saved, but the agent could not be rolled ({mutate.data.data.rollError}). The change
          applies when the agent next restarts.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
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

      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-sm" data-testid="scenarios-table">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-[10px] uppercase text-gray-600 dark:text-gray-400">
            <tr>
              <SortableHeader label="Scenario" sortKey="name" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="What it detects" sortKey="description" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="Events" sortKey="eventsPoured" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="Alerts" sortKey="alertsRaised" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="Mode" sortKey="simulated" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {isLoading && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-gray-500">Loading scenarios…</td></tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-xs text-gray-500">
                  {scenarios.length === 0
                    ? 'No scenarios reported — is the crowdsec-agent DaemonSet running?'
                    : 'No scenarios match the filter.'}
                </td>
              </tr>
            )}
            {rows.map((s) => (
              <tr key={s.name} data-testid={`scenario-row-${s.name}`}>
                <td className="px-5 py-2 font-mono text-[11px] text-gray-900 dark:text-gray-100">{s.name}</td>
                <td className="px-5 py-2 text-xs text-gray-600 dark:text-gray-400">{s.description || '—'}</td>
                <td className="px-5 py-2 text-right font-mono text-[11px] text-gray-700 dark:text-gray-300">
                  {s.eventsPoured.toLocaleString()}
                </td>
                <td className="px-5 py-2 text-right font-mono text-[11px] text-gray-700 dark:text-gray-300">
                  {s.alertsRaised.toLocaleString()}
                </td>
                <td className="px-5 py-2">
                  <button
                    type="button"
                    onClick={() => toggle(s)}
                    disabled={pending === s.name}
                    title={s.simulated
                      ? 'Alert-only. Click to let this scenario issue bans.'
                      : 'Issuing bans. Click to make it alert-only.'}
                    data-testid={`scenario-toggle-${s.name}`}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                      s.simulated
                        ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60'
                        : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:hover:bg-emerald-900/60'
                    }`}
                  >
                    {pending === s.name && <Loader2 size={10} className="animate-spin" />}
                    {s.simulated ? 'Alert only' : 'Bans'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[10px] text-gray-500 dark:text-gray-400">
        Event and alert counts are since the agent last started, not lifetime totals. Changing a
        mode rewrites the agent's simulation config and restarts it — CrowdSec reads that file
        only at startup, so nothing takes effect until it does.
      </p>
    </section>
  );
}
