/**
 * Community blocklist (CAPI) — CrowdSec's shared feed of IPs reported by other
 * CrowdSec installations.
 *
 *   CommunityBlocklistCard   — the WAF Settings section: opt-in switch, what it
 *                              means, and the viewer button.
 *   CommunityBlocklistBanner — Banned IPs tab notice while the feed enforces.
 *   CommunityBlocklistViewer — searchable, paginated list with per-IP Exclude.
 *
 * The switch and the viewer belong together: the switch decides whether tens
 * of thousands of externally-decided bans are enforced, and an operator cannot
 * make that call without being able to look at what is in the list. The feed
 * is kept out of the Banned IPs table because it is not the platform's
 * decisions — mixing them buried every operator ban on production (16,220
 * community entries against 2 of ours).
 */
import { useEffect, useMemo, useState } from 'react';
import { Globe, Search, ShieldAlert, X } from 'lucide-react';
import SortableHeader from '@/components/ui/SortableHeader';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSortable } from '@/hooks/use-sortable';
import {
  useAddCrowdsecAllowlistEntry,
  useCrowdsecCommunityBlocklist,
  useCrowdsecDecisions,
  useSetCrowdsecCommunityBlocklist,
} from '@/hooks/use-crowdsec';
import type { CrowdsecDecision, CrowdsecListDecisionsQuery } from '@insula/api-contracts';

/** WAF Settings → Community Blocklist: the opt-in switch and its viewer. */
export function CommunityBlocklistCard() {
  const [viewerOpen, setViewerOpen] = useState(false);
  const state = useCrowdsecCommunityBlocklist();
  const setEnabled = useSetCrowdsecCommunityBlocklist();
  const enabled = state.data?.data.enabled;
  const count = state.data?.data.decisionCount ?? 0;

  return (
    <section
      className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-3"
      data-testid="community-blocklist-section"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Globe size={15} /> Community Blocklist
            {state.data && (enabled ? (
              <span className="rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 px-2 py-0.5 text-[10px] font-medium uppercase">enabled</span>
            ) : (
              <span className="rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-2 py-0.5 text-[10px] font-medium uppercase">disabled</span>
            ))}
          </h3>
          <p className="mt-1 max-w-3xl text-xs text-gray-600 dark:text-gray-400" data-testid="capi-description">
            {state.isError
              ? 'Current state unknown — the setting could not be read. Do not assume it is off.'
              : enabled
              ? `${count.toLocaleString()} IPs banned by CrowdSec’s shared feed. These are decided elsewhere on evidence you cannot inspect — a legitimate scanner (MXToolbox) was blocked this way on 2026-09-06.`
              : 'Off. Only this platform’s own decisions are enforced. Turning it on bans tens of thousands of IPs decided by CrowdSec’s shared feed.'}
          </p>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-200">
          <input
            type="checkbox"
            data-testid="capi-toggle"
            className="rounded border-gray-300 dark:border-gray-600"
            checked={Boolean(enabled)}
            disabled={state.isLoading || state.isError || setEnabled.isPending}
            onChange={(e) => setEnabled.mutate({ enabled: e.target.checked })}
          />
          <span>
            Enable community blocklist
            {setEnabled.isPending && <span className="ml-1 font-normal text-gray-400 dark:text-gray-500">saving…</span>}
          </span>
        </label>
        <button
          type="button"
          data-testid="view-community-bans"
          onClick={() => setViewerOpen(true)}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <Search size={12} /> View banned IPs
        </button>
      </div>

      {state.isError && (
        <ErrorPanel error={extractOperatorError(state.error)} compact testId="capi-read-error" />
      )}
      {setEnabled.isError && (
        <ErrorPanel error={extractOperatorError(setEnabled.error)} compact testId="capi-write-error" />
      )}
      {state.data?.data.pendingRestart && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300" data-testid="capi-pending-restart">
          Setting saved, but {count.toLocaleString()} community decisions are still loaded — the CrowdSec pod
          is rolling onto the new setting.
        </p>
      )}
      {viewerOpen && <CommunityBlocklistViewer onClose={() => setViewerOpen(false)} total={count} />}
    </section>
  );
}

/** Paginated + searchable view of the community (CAPI) decisions. */
export function CommunityBlocklistViewer({ onClose, total }: { onClose: () => void; total: number }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const debouncedQ = useDebouncedValue(q, 400);
  const pageSize = 50;

  // Reset to the first page whenever the search changes, or a non-empty search
  // on page 5 would render an empty page and read as "no matches".
  useEffect(() => { setPage(0); }, [debouncedQ]);

  const query: CrowdsecListDecisionsQuery = useMemo(() => {
    const out: CrowdsecListDecisionsQuery = {
      source: 'community',
      limit: pageSize,
      offset: page * pageSize,
    };
    if (debouncedQ.trim()) out.q = debouncedQ.trim();
    return out;
  }, [debouncedQ, page]);

  const { data, isLoading, isError, error } = useCrowdsecDecisions(query);
  const rows = data?.data.decisions ?? [];
  const { sortedData: sortedRows, sortKey, sortDirection, onSort } =
    useSortable<CrowdsecDecision>(rows, 'value', 'asc');
  const matching = data?.data.totalMatching ?? 0;
  const pages = Math.max(1, Math.ceil(matching / pageSize));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-3xl rounded-lg bg-white dark:bg-gray-800 shadow-xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 p-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Community blocklist</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {total.toLocaleString()} IPs from CrowdSec&rsquo;s shared feed. Not this platform&rsquo;s decisions.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="community-viewer-close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="community-viewer-search"
            placeholder="Search by IP…"
            className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
          />

          {isError && (
            <div className="rounded border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-2 text-xs text-red-700 dark:text-red-300">
              Could not load the community blocklist: {error instanceof Error ? error.message : String(error)}
            </div>
          )}
          {isLoading && <div className="text-xs text-gray-500 dark:text-gray-400">Loading…</div>}

          {!isError && !isLoading && rows.length === 0 && (
            <div className="text-xs text-gray-500 dark:text-gray-400" data-testid="community-viewer-empty">
              {debouncedQ.trim() ? `No community ban matches “${debouncedQ.trim()}”.` : 'The community blocklist is empty.'}
            </div>
          )}

          {rows.length > 0 && (
            <table className="w-full text-left text-xs">
              <thead className="text-gray-500 dark:text-gray-400">
                <tr>
                  <SortableHeader label="IP" sortKey="value" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHeader label="Scenario" sortKey="scenario" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                  <SortableHeader label="Expires" sortKey="expiresAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                  <th className="py-1 font-medium text-right">Exclude</th>
                </tr>
              </thead>
              <tbody className="text-gray-800 dark:text-gray-100" data-testid="community-viewer-rows">
                {sortedRows.map((d) => (
                  <tr key={d.id} className="border-t border-gray-100 dark:border-gray-700">
                    <td className="py-1 font-mono">{d.value}</td>
                    <td className="py-1">{d.scenario}</td>
                    <td className="py-1 text-gray-500 dark:text-gray-400">
                      {d.expiresAt ? new Date(d.expiresAt).toLocaleString() : d.duration}
                    </td>
                    <td className="py-1 text-right">
                      <ExcludeCommunityIpButton value={d.value} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 p-3 text-xs text-gray-600 dark:text-gray-300">
          <span data-testid="community-viewer-count">
            {matching.toLocaleString()} match{matching === 1 ? '' : 'es'} · page {page + 1} of {pages}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded border border-gray-300 dark:border-gray-600 px-2 py-1 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              data-testid="community-viewer-next"
              disabled={page + 1 >= pages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded border border-gray-300 dark:border-gray-600 px-2 py-1 disabled:opacity-40"
            >
              Next
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Add one community-blocklist IP to the allowlist ("exclusion list").
 *
 * The allowlist beats every CrowdSec ban regardless of origin, so this is the
 * per-IP escape hatch from a decision made by someone else's feed — the case
 * that blocked MXToolbox on production while ordinary visitors were fine.
 * Excluding one scanner is a far smaller hammer than turning the whole feed off.
 */
function ExcludeCommunityIpButton({ value }: { value: string }) {
  const add = useAddCrowdsecAllowlistEntry();
  const done = add.isSuccess;

  return (
    <span className="inline-flex items-center gap-1">
      {add.isError && (
        <span className="text-[10px] text-red-600 dark:text-red-400" title={add.error instanceof Error ? add.error.message : ''}>
          failed
        </span>
      )}
      <button
        type="button"
        data-testid={`exclude-ip-${value}`}
        disabled={add.isPending || done}
        onClick={() => add.mutate({
          value,
          scope: 'Ip',
          // The comment is required by the contract (min 3 chars) so entries
          // are never anonymous; record WHY this one was excluded.
          comment: `Excluded from community blocklist via admin panel`,
        })}
        className="rounded border border-gray-300 px-2 py-0.5 text-[10px] text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
      >
        {done ? 'Excluded' : add.isPending ? 'Adding…' : 'Exclude'}
      </button>
    </span>
  );
}

/**
 * Banner on the Banned IPs tab when the community feed is enforcing.
 *
 * The tab deliberately lists only platform decisions now, so without this an
 * operator would see a handful of rows and reasonably conclude that is
 * everything being blocked — while tens of thousands of community bans are
 * also in force. States the count and links to the same viewer.
 */
export function CommunityBlocklistBanner() {
  const [open, setOpen] = useState(false);
  const state = useCrowdsecCommunityBlocklist();
  const info = state.data?.data;
  // Only claim it is active when we actually know it is.
  if (!info?.enabled) return null;

  return (
    <div
      data-testid="community-active-banner"
      className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-100"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Community blocklist is active</p>
            <p className="text-xs">
              <strong>{info.decisionCount.toLocaleString()}</strong> additional IPs are being blocked by
              CrowdSec&rsquo;s shared feed. They are <em>not</em> listed below — this table shows only
              decisions this platform made.
            </p>
          </div>
        </div>
        <button
          type="button"
          data-testid="banner-view-community"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded border border-blue-300 px-2 py-1 text-xs hover:bg-blue-100 dark:border-blue-600 dark:hover:bg-blue-800"
        >
          View banned IPs
        </button>
      </div>
      {open && <CommunityBlocklistViewer onClose={() => setOpen(false)} total={info.decisionCount} />}
    </div>
  );
}
