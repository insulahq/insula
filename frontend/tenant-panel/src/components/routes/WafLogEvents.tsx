/**
 * A route's WAF events, one row per rule match: filtered by source IP, rule,
 * path and outcome, sorted by the server and paged ("Show more"). The filters
 * are the parent's, so the summary can point here ("events from this IP").
 */
import { useEffect, useState, type FormEvent } from 'react';
import clsx from 'clsx';
import { Filter, Loader2, X } from 'lucide-react';
import { ROUTE_WAF_LOG_OUTCOMES, type RouteWafLogEntry, type RouteWafLogOutcome, type RouteWafLogSortField } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import LocalTime from '@/components/ui/LocalTime';
import PhoneSortBar from '@/components/ui/PhoneSortBar';
import { useIsPhone } from '@/hooks/use-is-phone';
import { useRouteWafLogPages, type RouteWafLogFilters, type RouteWafLogSort } from '@/hooks/use-route-waf';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { localZoneTitle } from '@/lib/format-timestamp';
import { utcOffsetLabel } from '@/lib/format-traffic';
import { WafNotBlockedBadge } from './WafNotBlockedBadge';

export const NO_WAF_LOG_FILTERS: RouteWafLogFilters = { outcome: 'all' };

const SEV_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  info: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
};

const OUTCOME_LABEL: Record<RouteWafLogOutcome, string> = {
  all: 'All outcomes',
  blocked: 'Blocked',
  not_blocked: 'Not blocked',
};

const SORTS: ReadonlyArray<{ readonly key: RouteWafLogSortField; readonly label: string }> = [
  { key: 'createdAt', label: 'Time' },
  { key: 'severity', label: 'Level' },
  { key: 'ruleId', label: 'Rule' },
  { key: 'sourceIp', label: 'IP' },
  { key: 'request', label: 'Request' },
];

const FILTER_INPUT =
  'rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-800 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500';

function getScore(msg: string): number | null {
  const m = msg.match(/Score:\s*(\d+)|Total Score:\s*(\d+)/);
  return m ? parseInt(m[1] || m[2], 10) : null;
}

/** What the filter inputs hold before Apply: free text, checked on apply. */
interface Draft { sourceIp: string; ruleId: string; path: string }

function draftOf(f: Pick<RouteWafLogFilters, 'sourceIp' | 'ruleId' | 'path'>): Draft {
  return { sourceIp: f.sourceIp ?? '', ruleId: f.ruleId ?? '', path: f.path ?? '' };
}

function draftError(d: Draft): string | null {
  if (d.sourceIp.trim() && !/^[0-9A-Fa-f.:]{2,45}$/.test(d.sourceIp.trim())) return 'IP: an IPv4 or IPv6 address';
  if (d.ruleId.trim() && !/^[0-9]{1,10}$/.test(d.ruleId.trim())) return 'Rule: the CRS rule number, digits only';
  if (d.path.trim() && !d.path.trim().startsWith('/')) return 'Path: starts with / (no query string)';
  return null;
}

export function WafLogEvents({ tenantId, routeId, filters, onFiltersChange }: {
  readonly tenantId: string;
  readonly routeId: string;
  readonly filters: RouteWafLogFilters;
  readonly onFiltersChange: (f: RouteWafLogFilters) => void;
}) {
  const isPhone = useIsPhone();
  const [sort, setSort] = useState<RouteWafLogSort>({ field: 'createdAt', direction: 'desc' });
  const [draft, setDraft] = useState<Draft>(draftOf(filters));
  // The summary can set a filter: the inputs follow it. Keyed on the three
  // values, so changing the outcome keeps text typed but not applied yet.
  useEffect(() => {
    setDraft(draftOf({ sourceIp: filters.sourceIp, ruleId: filters.ruleId, path: filters.path }));
  }, [filters.sourceIp, filters.ruleId, filters.path]);

  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useRouteWafLogPages(tenantId, routeId, filters, sort);
  const logs: readonly RouteWafLogEntry[] = data?.pages.flatMap((p) => p.data) ?? [];
  const total = data?.pages[0]?.pagination?.total_count ?? logs.length;
  const invalid = draftError(draft);
  const active = Boolean(filters.sourceIp || filters.ruleId || filters.path || filters.outcome !== 'all');

  const toggleSort = (key: string) => {
    const field = key as RouteWafLogSortField;
    setSort((s) => (s.field === field ? { field, direction: s.direction === 'asc' ? 'desc' : 'asc' } : { field, direction: 'desc' }));
  };
  const apply = (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    onFiltersChange({
      ...filters,
      sourceIp: draft.sourceIp.trim() || undefined,
      ruleId: draft.ruleId.trim() || undefined,
      path: draft.path.trim() || undefined,
    });
  };
  const filterIp = (ip: string | null) => { if (ip) onFiltersChange({ ...filters, sourceIp: ip }); };

  // A plain function, not a component: one defined in render would remount every render.
  const sortHeader = ({ label, k, className, title }: { label: string; k?: RouteWafLogSortField; className?: string; title?: string }) => (
    <th
      className={clsx('px-2 py-2 select-none', k && 'cursor-pointer hover:text-gray-300 transition-colors', className)}
      onClick={k ? () => toggleSort(k) : undefined}
      title={title}
      aria-sort={k && sort.field === k ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
      data-testid={k ? `waf-log-sort-${k}` : undefined}
    >
      {label} {k && sort.field === k ? (sort.direction === 'asc' ? '▲' : '▼') : ''}
    </th>
  );

  const ipButton = (log: RouteWafLogEntry) => (
    log.sourceIp
      ? (
        <button
          type="button"
          onClick={() => filterIp(log.sourceIp)}
          className="text-gray-300 underline decoration-dotted underline-offset-2 hover:text-white"
          title={`Show only events from ${log.sourceIp}`}
          data-testid={`waf-log-ip-${log.id}`}
        >
          {log.sourceIp}
        </button>
      )
      : <span className="text-gray-500">-</span>
  );

  return (
    <div className="space-y-2" data-testid="waf-log-events">
      <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300" data-testid="waf-log-latest-heading">
        Events{data ? ` (${total.toLocaleString()}${active ? ' matching' : ''})` : ''}
      </h4>
      <form onSubmit={apply} className="flex flex-wrap items-center gap-2" data-testid="waf-log-filters">
        <input
          value={draft.sourceIp}
          onChange={(e) => setDraft({ ...draft, sourceIp: e.target.value })}
          placeholder="Source IP"
          aria-label="Filter by source IP"
          className={clsx(FILTER_INPUT, 'w-40 font-mono')}
          data-testid="waf-log-filter-ip"
        />
        <input
          value={draft.ruleId}
          onChange={(e) => setDraft({ ...draft, ruleId: e.target.value })}
          placeholder="Rule"
          aria-label="Filter by rule id"
          className={clsx(FILTER_INPUT, 'w-20 font-mono')}
          data-testid="waf-log-filter-rule"
        />
        <input
          value={draft.path}
          onChange={(e) => setDraft({ ...draft, path: e.target.value })}
          placeholder="/path"
          aria-label="Filter by request path"
          className={clsx(FILTER_INPUT, 'w-40 font-mono')}
          data-testid="waf-log-filter-path"
        />
        <select
          value={filters.outcome}
          onChange={(e) => onFiltersChange({ ...filters, outcome: e.target.value as RouteWafLogOutcome })}
          aria-label="Filter by outcome"
          className={FILTER_INPUT}
          data-testid="waf-log-filter-outcome"
        >
          {ROUTE_WAF_LOG_OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}
        </select>
        <button
          type="submit"
          disabled={invalid !== null}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          data-testid="waf-log-filter-apply"
        >
          <Filter size={12} /> Filter
        </button>
        {active && (
          <button
            type="button"
            onClick={() => onFiltersChange(NO_WAF_LOG_FILTERS)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            data-testid="waf-log-filter-clear"
          >
            <X size={12} /> Clear filters
          </button>
        )}
      </form>
      {invalid && <p className="text-[11px] text-red-600 dark:text-red-400" data-testid="waf-log-filter-error">{invalid}</p>}

      {isError && <ErrorPanel error={extractOperatorError(error)} compact testId="waf-log-error" />}
      {isLoading ? (
        <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-blue-600" /></div>
      ) : !isError && logs.length === 0 ? (
        <div className="py-4 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="waf-log-empty">
          {active ? 'No WAF events match these filters.' : 'No WAF events recorded.'}
        </div>
      ) : logs.length > 0 && isPhone ? (
        <div className="rounded-xl bg-gray-950 font-mono text-[11px]" data-testid="waf-log-entries">
          <PhoneSortBar
            options={SORTS}
            sortKey={sort.field}
            direction={sort.direction}
            onSort={toggleSort}
            className="border-b border-gray-800 px-3 py-2 font-sans"
          />
          <ul className="divide-y divide-gray-800">
            {logs.map((log) => {
              const score = getScore(log.message);
              return (
                <li key={log.id} className="space-y-1 px-3 py-2.5" data-testid={`waf-log-entry-${log.id}`}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={clsx('inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', SEV_STYLE[log.severity] ?? SEV_STYLE.info)}>
                      {log.severity}
                    </span>
                    <span className="font-bold text-blue-400">{log.ruleId}</span>
                    {score !== null && <span className="font-bold text-amber-400">score {score}</span>}
                    <WafNotBlockedBadge detectionOnly={log.detectionOnly} passReason={log.passReason ?? null} testId={`waf-log-detected-${log.id}`} />
                  </div>
                  <p className="break-words text-gray-300">{log.ruleId === '949110' ? 'Anomaly Threshold' : log.message}</p>
                  <p className="break-all text-green-400">{log.requestMethod ?? 'GET'} {log.requestUri ?? '/'}</p>
                  <p className="flex flex-wrap gap-x-3 text-gray-500">
                    <LocalTime iso={log.createdAt} />
                    {ipButton(log)}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : logs.length > 0 ? (
        <div className="overflow-x-auto rounded-xl" data-testid="waf-log-entries">
          <table className="w-full font-mono text-[11px] bg-gray-950">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500 text-left">
                {sortHeader({ label: `Time (${utcOffsetLabel()})`, k: 'createdAt', className: 'w-[110px] whitespace-nowrap', title: localZoneTitle() })}
                {sortHeader({ label: 'IP', k: 'sourceIp', className: 'whitespace-nowrap' })}
                {sortHeader({ label: 'Level', k: 'severity', className: 'w-[62px]' })}
                {sortHeader({ label: 'Rule', k: 'ruleId' })}
                {sortHeader({ label: 'Score', className: 'w-[48px]' })}
                {sortHeader({ label: 'Request', k: 'request' })}
              </tr>
            </thead>
            <tbody>
              {logs.map((log, idx) => {
                const score = getScore(log.message);
                return (
                  <tr key={log.id} className={clsx(idx % 2 === 0 ? 'bg-gray-950' : 'bg-gray-900')} data-testid={`waf-log-entry-${log.id}`}>
                    <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap"><LocalTime iso={log.createdAt} /></td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{ipButton(log)}</td>
                    <td className="px-2 py-1.5">
                      <span className={clsx('inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', SEV_STYLE[log.severity] ?? SEV_STYLE.info)}>
                        {log.severity}
                      </span>
                    </td>
                    <td className="px-2 py-1.5" title={log.message}>
                      <WafNotBlockedBadge
                        detectionOnly={log.detectionOnly}
                        passReason={log.passReason ?? null}
                        testId={`waf-log-detected-${log.id}`}
                        className="mr-1.5"
                      />
                      <span className="text-blue-400 font-bold">{log.ruleId}</span>
                      <span className="text-gray-600 mx-1">-</span>
                      <span className="text-gray-300">{log.ruleId === '949110' ? 'Anomaly Threshold' : log.message}</span>
                    </td>
                    <td className="px-2 py-1.5 text-amber-400 font-bold whitespace-nowrap">{score ?? ''}</td>
                    <td className="px-2 py-1.5 text-green-400 truncate max-w-[400px]" title={`${log.requestMethod ?? 'GET'} ${log.requestUri ?? '/'}`}>
                      {log.requestMethod ?? 'GET'} {log.requestUri ?? '/'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => { void fetchNextPage(); }}
            disabled={isFetchingNextPage}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            data-testid="waf-log-more"
          >
            {isFetchingNextPage && <Loader2 size={12} className="animate-spin" />}
            Show more ({logs.length.toLocaleString()} of {total.toLocaleString()})
          </button>
        </div>
      )}
    </div>
  );
}
