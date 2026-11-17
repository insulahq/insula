/**
 * A route's WAF events by source address: who sent the requests that
 * matched rules, how many of them were let through and why, and the two
 * things a tenant does with an address — look at its events, or trust it.
 * The API ranks rows by requests and returns at most 200.
 */
import { useMemo } from 'react';
import { ShieldPlus } from 'lucide-react';
import { WAF_PASS_REASON_LABEL, type WafLogSourcesResponse } from '@insula/api-contracts';
import LocalTime from '@/components/ui/LocalTime';
import SortableHeader from '@/components/ui/SortableHeader';
import { useSortable } from '@/hooks/use-sortable';
import { localZoneTitle } from '@/lib/format-timestamp';
import { utcOffsetLabel } from '@/lib/format-traffic';

export function WafLogSources({ sources, onFilterIp, onTrustIp }: {
  readonly sources: WafLogSourcesResponse;
  readonly onFilterIp: (ip: string) => void;
  readonly onTrustIp: (ip: string) => void;
}) {
  const rows = useMemo(
    () => sources.rows.map((r) => ({ ...r, lastSeenAtMs: Date.parse(r.lastSeenAt) })),
    [sources],
  );
  const { sortedData, sortKey, sortDirection, onSort } = useSortable(rows, 'requests', 'desc');
  const th = { currentKey: sortKey, direction: sortDirection, onSort, className: '!px-3 !py-2 text-left' };

  if (rows.length === 0) {
    return (
      <p className="px-3 py-4 text-center text-xs text-gray-500 dark:text-gray-400" data-testid="waf-sources-empty">
        No source addresses in this window.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto" data-testid="waf-sources">
      <table className="min-w-full text-xs">
        <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-500 dark:text-gray-400 uppercase">
          <tr>
            <SortableHeader label="Source IP" sortKey="sourceIp" {...th} />
            <SortableHeader label="Requests" sortKey="requests" {...th} />
            <th className="px-3 py-2 text-left">Top rules</th>
            <SortableHeader label="Paths" sortKey="paths" {...th} />
            <SortableHeader label={`Last seen (${utcOffsetLabel()})`} sortKey="lastSeenAtMs" {...th} className={`${th.className} whitespace-nowrap`} title={localZoneTitle()} />
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {sortedData.map((r) => (
            <tr key={r.sourceIp} data-testid={`waf-source-row-${r.sourceIp}`}>
              <td className="px-3 py-2 font-mono text-[11px] text-gray-900 dark:text-gray-100 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onFilterIp(r.sourceIp)}
                  className="underline decoration-dotted underline-offset-2 hover:text-blue-700 dark:hover:text-blue-300"
                  title={`Show this address's events below`}
                  data-testid={`waf-source-ip-${r.sourceIp}`}
                >
                  {r.sourceIp}
                </button>
              </td>
              <td className="px-3 py-2 text-gray-900 dark:text-gray-100 whitespace-nowrap">
                {r.requests.toLocaleString()}
                {r.notBlocked > 0 && (
                  <div className="text-[11px] text-amber-700 dark:text-amber-300" data-testid={`waf-source-not-blocked-${r.sourceIp}`}>
                    {r.notBlocked === r.requests ? 'none blocked' : `${r.notBlocked.toLocaleString()} not blocked`}
                    {r.passReasons.length > 0 && ` · ${r.passReasons.map((p) => WAF_PASS_REASON_LABEL[p]).join(', ')}`}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-gray-700 dark:text-gray-300">{r.topRules.join(', ') || '—'}</td>
              <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{r.paths.toLocaleString()}</td>
              <td className="px-3 py-2 text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap"><LocalTime iso={r.lastSeenAt} /></td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                {r.trusted ? (
                  <span
                    className="inline-flex rounded px-2 py-0.5 text-[10px] font-medium uppercase bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
                    title="Covered by one of this route's WAF trusted IPs: checked and logged, never blocked"
                    data-testid={`waf-source-trusted-${r.sourceIp}`}
                  >
                    trusted
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onTrustIp(r.sourceIp)}
                    className="inline-flex items-center gap-1 rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
                    title="Add to this route's WAF trusted IPs: its requests are checked and logged but never blocked"
                    data-testid={`waf-source-trust-${r.sourceIp}`}
                  >
                    <ShieldPlus size={11} /> Trust
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sources.truncated && (
        <p className="px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">Only the 200 busiest addresses are shown.</p>
      )}
    </div>
  );
}
