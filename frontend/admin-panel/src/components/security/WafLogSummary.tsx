/**
 * WAF events grouped by host, rule and request path, and how long events are kept.
 *
 *   WafEventsSummaryTable — WAF Events → "Summary": what was blocked (or, in
 *                           detection-only mode, would have been), per rule and
 *                           path, with a "Whitelist on this path" action.
 *   WafLogRetentionCard   — WAF Settings: the retention in days, the fixed
 *                           flood ceilings, and what is stored right now.
 *
 * The summary is the view a detection dry run is judged from: a week of raw
 * events is a list nobody reads, while "941100 on /mod/forum/post.php, 312
 * requests from 40 IPs" is a decision.
 */
import { useState } from 'react';
import { Archive, ShieldCheck } from 'lucide-react';
import type { WafEventsQuery, WafLogSummaryRow } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import LocalTime from '@/components/ui/LocalTime';
import SortableHeader from '@/components/ui/SortableHeader';
import { SkeletonLoader } from '@/components/ui/SkeletonLoader';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { utcOffsetLabel } from '@/lib/format-traffic';
import { useSortable } from '@/hooks/use-sortable';
import { usePatchWafLogSettings, useWafEventsSummary, useWafLogSettings } from '@/hooks/use-waf-log-summary';

export function WafEventsSummaryTable({ query, onWhitelist }: {
  readonly query: WafEventsQuery;
  readonly onWhitelist: (row: WafLogSummaryRow) => void;
}) {
  const { data, isLoading, isError, error } = useWafEventsSummary(query, true);
  const summary = data?.data;
  const { sortedData, sortKey, sortDirection, onSort } = useSortable<WafLogSummaryRow>(summary?.rows ?? [], 'requests', 'desc');

  if (isLoading) return <SkeletonLoader />;
  if (isError) return <ErrorPanel error={extractOperatorError(error)} compact testId="waf-summary-error" />;
  if (!summary) return null;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden" data-testid="waf-summary">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm text-gray-900 dark:text-gray-100 flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium" data-testid="waf-summary-total">
          {summary.requests.toLocaleString()} request{summary.requests === 1 ? '' : 's'} blocked or flagged · {summary.rows.length}
          {summary.truncated ? '+' : ''} rule × path group{summary.rows.length === 1 ? '' : 's'}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">Same filters as the event list. A request can match several rules.</span>
      </div>
      {summary.rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="waf-summary-empty">
          Nothing matched these filters.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <tr>
                <SortableHeader label="Host" sortKey="hostname" currentKey={sortKey} direction={sortDirection} onSort={onSort} padding="px-3 py-2" />
                <SortableHeader label="Rule" sortKey="ruleId" currentKey={sortKey} direction={sortDirection} onSort={onSort} padding="px-3 py-2" />
                <SortableHeader label="Path" sortKey="path" currentKey={sortKey} direction={sortDirection} onSort={onSort} padding="px-3 py-2" />
                <SortableHeader label="Requests" sortKey="requests" currentKey={sortKey} direction={sortDirection} onSort={onSort} padding="px-3 py-2" />
                <SortableHeader label="IPs" sortKey="sourceIps" currentKey={sortKey} direction={sortDirection} onSort={onSort} padding="px-3 py-2" />
                <SortableHeader label={`Last seen (${utcOffsetLabel()})`} sortKey="lastSeenAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} padding="px-3 py-2" />
                <th className="px-3 py-2 text-left">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sortedData.map((r) => {
                const key = `${r.hostname}|${r.ruleId}|${r.path}`;
                return (
                  <tr key={key} data-testid={`waf-summary-row-${r.ruleId}-${r.path}`}>
                    <td className="px-3 py-2 font-mono text-[11px] text-gray-700 dark:text-gray-200 break-all">{r.hostname}</td>
                    <td className="px-3 py-2 text-xs text-gray-900 dark:text-gray-100">
                      <span className="font-mono">{r.ruleId}</span>
                      <div className="text-[11px] text-gray-500 dark:text-gray-400">{r.message}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-gray-700 dark:text-gray-200 break-all">{r.path}</td>
                    <td className="px-3 py-2 text-xs text-gray-900 dark:text-gray-100 whitespace-nowrap">
                      {r.requests.toLocaleString()}
                      {r.detectionOnly > 0 && (
                        <div className="text-[11px] text-amber-700 dark:text-amber-300" data-testid={`waf-summary-detected-${r.ruleId}-${r.path}`}>
                          {r.detectionOnly === r.requests ? 'detected, not blocked' : `${r.detectionOnly.toLocaleString()} not blocked`}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-200">{r.sourceIps.toLocaleString()}</td>
                    <td className="px-3 py-2 text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      <LocalTime iso={r.lastSeenAt} />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => onWhitelist(r)}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 whitespace-nowrap"
                        data-testid={`waf-summary-whitelist-${r.ruleId}-${r.path}`}
                        title={`Add an exclusion for rule ${r.ruleId} on ${r.hostname} ${r.path}`}
                      >
                        <ShieldCheck size={11} /> Whitelist on this path
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function WafLogRetentionCard() {
  const settings = useWafLogSettings();
  const patch = usePatchWafLogSettings();
  const s = settings.data?.data;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (s ? String(s.retentionDays) : '');
  const days = Number(value);
  const valid = Number.isInteger(days) && days >= 1 && days <= 365;
  const dirty = Boolean(s) && valid && days !== s?.retentionDays;

  return (
    <section
      className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-3"
      data-testid="waf-retention-card"
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <Archive size={15} /> WAF event retention
      </h3>
      <p className="max-w-3xl text-xs text-gray-600 dark:text-gray-400">
        How long blocked and detection-only events are kept for WAF Events, the routes&apos; WAF logs and
        their summaries. Run a route in detection-only mode for as long as this keeps events, then decide its
        exceptions from the summary.
      </p>
      {settings.isError && <ErrorPanel error={extractOperatorError(settings.error)} compact testId="waf-retention-read-error" />}
      {s && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-gray-700 dark:text-gray-200">
              Keep events for (days)
              <input
                type="number"
                min={1}
                max={365}
                value={value}
                onChange={(e) => setDraft(e.target.value)}
                aria-invalid={!valid}
                className="w-28 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
                data-testid="waf-retention-days"
              />
            </label>
            <button
              type="button"
              disabled={!dirty || patch.isPending}
              onClick={() => patch.mutate({ retentionDays: days }, { onSuccess: () => setDraft(null) })}
              className="rounded-md px-3 py-1.5 text-sm border border-emerald-300 bg-emerald-600 dark:bg-emerald-700 text-white hover:bg-emerald-700 dark:hover:bg-emerald-600 disabled:opacity-50"
              data-testid="waf-retention-save"
            >
              {patch.isPending ? 'Saving…' : 'Save'}
            </button>
            {!valid && <span className="text-[11px] text-red-600 dark:text-red-400" data-testid="waf-retention-invalid">A whole number from 1 to 365.</span>}
          </div>
          {patch.isError && <ErrorPanel error={extractOperatorError(patch.error)} compact testId="waf-retention-write-error" />}
          <ul className="list-disc pl-5 text-xs text-gray-600 dark:text-gray-400 space-y-0.5" data-testid="waf-retention-facts">
            <li>
              Stored now: {s.storedEvents.toLocaleString()} event{s.storedEvents === 1 ? '' : 's'}
              {s.oldestEventAt && <>, the oldest from <LocalTime iso={s.oldestEventAt} /></>}.
            </li>
            <li>
              Flood limit: at most {s.routeCeiling.toLocaleString()} per site and {s.adminHostCeiling.toLocaleString()} for
              the platform hosts together; the oldest go first.
            </li>
            <li>
              Events younger than {s.protectedRecentMinutes} minutes are always kept, so auto-ban sees a flood whole.
            </li>
          </ul>
        </>
      )}
    </section>
  );
}
