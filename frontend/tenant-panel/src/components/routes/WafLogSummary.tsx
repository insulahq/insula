/**
 * A route's WAF events grouped by rule and request path — what the WAF
 * blocked, or in detection-only mode would have blocked — with a one-click
 * exclusion for that rule on that path; or grouped by source address, with
 * "show its events" and "trust it".
 *
 * Detection-only mode is a dry run: run it for a while, read this, add the
 * exclusions your site needs, then enforce. The event list below it shows
 * single requests; this shows what to decide.
 */
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ShieldCheck } from 'lucide-react';
import { WAF_LOG_SUMMARY_WINDOWS, type WafLogSummaryRow } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import LocalTime from '@/components/ui/LocalTime';
import SortableHeader from '@/components/ui/SortableHeader';
import { useSortable } from '@/hooks/use-sortable';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { utcOffsetLabel } from '@/lib/format-traffic';
import { localZoneTitle } from '@/lib/format-timestamp';
import { useRouteWafLogSummary } from '@/hooks/use-route-settings';
import { useRouteWafLogSources } from '@/hooks/use-route-waf';
import { WafLogSources } from './WafLogSources';

type SummaryView = 'rules' | 'sources';

const WINDOW_LABEL: Record<(typeof WAF_LOG_SUMMARY_WINDOWS)[number], string> = {
  86_400: 'Last 24 hours',
  604_800: 'Last 7 days',
  2_592_000: 'Last 30 days',
};

export function WafLogSummary({ tenantId, routeId, onExclude, onFilterIp, onTrustIp }: {
  readonly tenantId: string;
  readonly routeId: string;
  readonly onExclude: (row: WafLogSummaryRow) => void;
  /** Show only this address's events in the list below. */
  readonly onFilterIp: (ip: string) => void;
  /** Open "trust this address" for this route. */
  readonly onTrustIp: (ip: string) => void;
}) {
  const [sinceSeconds, setSinceSeconds] = useState<(typeof WAF_LOG_SUMMARY_WINDOWS)[number]>(604_800);
  const [view, setView] = useState<SummaryView>('rules');
  const { data, isLoading, isError, error } = useRouteWafLogSummary(tenantId, routeId, sinceSeconds);
  const sourcesQuery = useRouteWafLogSources(tenantId, view === 'sources' ? routeId : undefined, sinceSeconds);
  const summary = data?.data;
  const notBlocked = summary?.notBlocked ?? 0;
  // Biggest group first, as the API ranks them (and truncates: the note below
  // says so, so a re-sort is over a set the page names).
  const rows = useMemo(
    () => (summary?.rows ?? []).map((r) => ({ ...r, lastSeenAtMs: Date.parse(r.lastSeenAt) })),
    [summary],
  );
  const { sortedData: sortedRows, sortKey, sortDirection, onSort } = useSortable(rows, 'requests', 'desc');
  const th = { currentKey: sortKey, direction: sortDirection, onSort, className: '!px-3 !py-2 text-left' };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700" data-testid="waf-summary">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 dark:border-gray-700 px-3 py-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200" data-testid="waf-summary-total">
          {summary
            ? notBlocked > 0
              ? `${summary.requests.toLocaleString()} request${summary.requests === 1 ? '' : 's'} matched rules — ${notBlocked.toLocaleString()} not blocked`
              : `${summary.requests.toLocaleString()} request${summary.requests === 1 ? '' : 's'} blocked or flagged`
            : 'WAF events'}
        </span>
        <div className="inline-flex rounded-md border border-gray-300 dark:border-gray-600 p-0.5" role="group" aria-label="Group events by">
          {(['rules', 'sources'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={clsx(
                'rounded px-2 py-0.5 text-[11px] font-medium',
                view === v
                  ? 'bg-gray-700 text-white dark:bg-gray-200 dark:text-gray-900'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
              )}
              data-testid={`waf-summary-view-${v}`}
            >
              {v === 'rules' ? 'By rule and path' : 'By source IP'}
            </button>
          ))}
        </div>
        <select
          value={sinceSeconds}
          onChange={(e) => setSinceSeconds(Number(e.target.value) as (typeof WAF_LOG_SUMMARY_WINDOWS)[number])}
          className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-700 dark:text-gray-200"
          aria-label="Summary window"
          data-testid="waf-summary-window"
        >
          {WAF_LOG_SUMMARY_WINDOWS.map((w) => <option key={w} value={w}>{WINDOW_LABEL[w]}</option>)}
        </select>
      </div>
      {view === 'sources' && (
        <>
          {sourcesQuery.isError && <div className="p-3"><ErrorPanel error={extractOperatorError(sourcesQuery.error)} compact testId="waf-sources-error" /></div>}
          {sourcesQuery.isLoading && <p className="px-3 py-4 text-center text-xs text-gray-500 dark:text-gray-400">Loading…</p>}
          {sourcesQuery.data?.data && (
            <WafLogSources sources={sourcesQuery.data.data} onFilterIp={onFilterIp} onTrustIp={onTrustIp} />
          )}
        </>
      )}
      {view === 'rules' && isError && <div className="p-3"><ErrorPanel error={extractOperatorError(error)} compact testId="waf-summary-error" /></div>}
      {view === 'rules' && isLoading && <p className="px-3 py-4 text-center text-xs text-gray-500 dark:text-gray-400">Loading…</p>}
      {view === 'rules' && summary && summary.rows.length === 0 && (
        <p className="px-3 py-4 text-center text-xs text-gray-500 dark:text-gray-400" data-testid="waf-summary-empty">
          Nothing blocked or flagged in this window.
        </p>
      )}
      {view === 'rules' && summary && summary.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-500 dark:text-gray-400 uppercase">
              <tr>
                <SortableHeader label="Rule" sortKey="ruleId" {...th} />
                <SortableHeader label="Path" sortKey="path" {...th} />
                <SortableHeader label="Requests" sortKey="requests" {...th} />
                <SortableHeader label="IPs" sortKey="sourceIps" {...th} />
                <SortableHeader label={`Last seen (${utcOffsetLabel()})`} sortKey="lastSeenAtMs" {...th} className={`${th.className} whitespace-nowrap`} title={localZoneTitle()} />
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sortedRows.map((r) => (
                <tr key={`${r.ruleId}|${r.path}`} data-testid={`waf-summary-row-${r.ruleId}-${r.path}`}>
                  <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
                    <span className="font-mono">{r.ruleId}</span>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">{r.message}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-gray-700 dark:text-gray-300 break-all">{r.path}</td>
                  <td className="px-3 py-2 text-gray-900 dark:text-gray-100 whitespace-nowrap">
                    {r.requests.toLocaleString()}
                    {(r.notBlocked ?? r.detectionOnly) > 0 && (
                      <div className="text-[11px] text-amber-700 dark:text-amber-300" data-testid={`waf-summary-not-blocked-${r.ruleId}-${r.path}`}>
                        {notBlockedText(r)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-300">
                    {r.sourceIps.toLocaleString()}
                    {(r.topSourceIps ?? []).length > 0 && (
                      <div className="mt-0.5 space-y-0.5">
                        {(r.topSourceIps ?? []).map((t) => (
                          <button
                            key={t.sourceIp}
                            type="button"
                            onClick={() => onFilterIp(t.sourceIp)}
                            className="block font-mono text-[11px] text-gray-600 dark:text-gray-400 underline decoration-dotted underline-offset-2 hover:text-blue-700 dark:hover:text-blue-300 whitespace-nowrap"
                            title={`Show the events from ${t.sourceIp}`}
                            data-testid={`waf-summary-ip-${r.ruleId}-${t.sourceIp}`}
                          >
                            {t.sourceIp} ×{t.requests.toLocaleString()}
                          </button>
                        ))}
                        {r.sourceIps > (r.topSourceIps ?? []).length && (
                          <span className="block text-[10px] text-gray-500 dark:text-gray-400">
                            +{(r.sourceIps - (r.topSourceIps ?? []).length).toLocaleString()} more
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap"><LocalTime iso={r.lastSeenAt} /></td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onExclude(r)}
                      className="inline-flex items-center gap-1 rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 whitespace-nowrap"
                      data-testid={`waf-summary-exclude-${r.ruleId}-${r.path}`}
                    >
                      <ShieldCheck size={11} /> Exclude on this path
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {summary.truncated && (
            <p className="px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">Only the 200 largest groups are shown.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** "detected, not blocked" for a detection-only route; otherwise how many of the group passed. */
function notBlockedText(r: WafLogSummaryRow): string {
  const notBlocked = r.notBlocked ?? r.detectionOnly;
  if (notBlocked === r.requests) return r.detectionOnly === r.requests ? 'detected, not blocked' : 'none blocked';
  return `${notBlocked.toLocaleString()} not blocked`;
}
