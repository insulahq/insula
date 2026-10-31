/**
 * A route's WAF events grouped by rule and request path — what the WAF
 * blocked, or in detection-only mode would have blocked — with a one-click
 * exclusion for that rule on that path.
 *
 * Detection-only mode is a dry run: run it for a while, read this, add the
 * exclusions your site needs, then enforce. The latest-events list below it
 * shows single requests; this shows what to decide.
 */
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { WAF_LOG_SUMMARY_WINDOWS, type WafLogSummaryRow } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import LocalTime from '@/components/ui/LocalTime';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { utcOffsetLabel } from '@/lib/format-traffic';
import { localZoneTitle } from '@/lib/format-timestamp';
import { useRouteWafLogSummary } from '@/hooks/use-route-settings';

const WINDOW_LABEL: Record<(typeof WAF_LOG_SUMMARY_WINDOWS)[number], string> = {
  86_400: 'Last 24 hours',
  604_800: 'Last 7 days',
  2_592_000: 'Last 30 days',
};

export function WafLogSummary({ tenantId, routeId, onExclude }: {
  readonly tenantId: string;
  readonly routeId: string;
  readonly onExclude: (row: WafLogSummaryRow) => void;
}) {
  const [sinceSeconds, setSinceSeconds] = useState<(typeof WAF_LOG_SUMMARY_WINDOWS)[number]>(604_800);
  const { data, isLoading, isError, error } = useRouteWafLogSummary(tenantId, routeId, sinceSeconds);
  const summary = data?.data;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700" data-testid="waf-summary">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 dark:border-gray-700 px-3 py-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200" data-testid="waf-summary-total">
          {summary
            ? `${summary.requests.toLocaleString()} request${summary.requests === 1 ? '' : 's'} blocked or flagged — by rule and path`
            : 'By rule and path'}
        </span>
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
      {isError && <div className="p-3"><ErrorPanel error={extractOperatorError(error)} compact testId="waf-summary-error" /></div>}
      {isLoading && <p className="px-3 py-4 text-center text-xs text-gray-500 dark:text-gray-400">Loading…</p>}
      {summary && summary.rows.length === 0 && (
        <p className="px-3 py-4 text-center text-xs text-gray-500 dark:text-gray-400" data-testid="waf-summary-empty">
          Nothing blocked or flagged in this window.
        </p>
      )}
      {summary && summary.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-500 dark:text-gray-400 uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Rule</th>
                <th className="px-3 py-2 text-left">Path</th>
                <th className="px-3 py-2 text-left">Requests</th>
                <th className="px-3 py-2 text-left">IPs</th>
                <th className="px-3 py-2 text-left whitespace-nowrap" title={localZoneTitle()}>Last seen ({utcOffsetLabel()})</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {summary.rows.map((r) => (
                <tr key={`${r.ruleId}|${r.path}`} data-testid={`waf-summary-row-${r.ruleId}-${r.path}`}>
                  <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
                    <span className="font-mono">{r.ruleId}</span>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">{r.message}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-gray-700 dark:text-gray-300 break-all">{r.path}</td>
                  <td className="px-3 py-2 text-gray-900 dark:text-gray-100 whitespace-nowrap">
                    {r.requests.toLocaleString()}
                    {r.detectionOnly > 0 && (
                      <div className="text-[11px] text-amber-700 dark:text-amber-300">
                        {r.detectionOnly === r.requests ? 'detected, not blocked' : `${r.detectionOnly.toLocaleString()} not blocked`}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{r.sourceIps.toLocaleString()}</td>
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
