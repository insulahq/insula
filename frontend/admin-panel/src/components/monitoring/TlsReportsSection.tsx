/**
 * TLS-RPT reports (RFC 8460).
 *
 * These are about INBOUND delivery: a receiver telling us whether it could
 * negotiate TLS to our MX. A failure is ours to fix — an expired certificate,
 * an MTA-STS policy that stopped matching, a stale MX record — not the
 * sender's, which is the opposite of how the abuse section next door reads.
 *
 * The session totals are shown with the failure count and never without it.
 * "12 failed sessions" is a crisis at a small domain and background noise at a
 * large one, and a success rate with no denominator is the figure that gets
 * acted on when it should not be — the same discipline as the DMARC pass rate.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock, LockOpen, Loader2, ChevronRight, ChevronDown, Info } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import SortableHeader from '@/components/ui/SortableHeader';
import TableSearch from '@/components/ui/TableSearch';
import TablePager from '@/components/ui/TablePager';
import { useTableView } from '@/hooks/use-table-view';
import type { SortAccessors } from '@/hooks/use-sortable';
import type { TlsReportsOverview, TlsReport } from '@insula/api-contracts';

/** The most the endpoint returns; the table searches and pages them in the browser. */
const REPORTS_FETCHED = 200;

function useTlsReports(windowDays: number, failingOnly: boolean) {
  return useQuery({
    queryKey: ['mail', 'tls-reports', windowDays, failingOnly],
    queryFn: () => apiFetch<{ data: TlsReportsOverview }>(
      `/api/v1/admin/mail/tls-reports?windowDays=${windowDays}&limit=${REPORTS_FETCHED}${failingOnly ? '&failingOnly=true' : ''}`,
    ),
    staleTime: 60_000,
  });
}

type Failure = TlsReport['failures'][number];

const reportText = (r: TlsReport): string => [
  r.policyDomain, r.orgName, r.contactInfo,
  ...r.failures.flatMap((f) => [f.resultType, f.receivingMxHostname, f.sendingMtaIp]),
].filter(Boolean).join(' ');
// The lock column sorts failing reports together, by how many sessions failed.
const REPORT_SORT: SortAccessors<TlsReport> = { tls: (r) => r.failedSessions };
const failureText = (f: Failure): string => [f.resultType, f.receivingMxHostname, f.sendingMtaIp].filter(Boolean).join(' ');
const NO_ACCESSORS: SortAccessors<Failure> = {};
const TH = 'font-medium';
const TH_PAD = 'px-3 py-2';
const SUB_TH_PAD = 'pb-1 pr-4';
/** Detail rows rarely fill a page; the search box appears only when they do. */
const SEARCH_FROM_ROWS = 20;

function FailureTable({ report }: { readonly report: TlsReport }) {
  const view = useTableView(report.failures, {
    searchText: failureText, defaultSortKey: 'failedSessionCount', defaultDirection: 'desc', accessors: NO_ACCESSORS,
  });
  const header = (label: string, key: string) => (
    <SortableHeader label={label} sortKey={key} currentKey={view.sortKey} direction={view.sortDirection}
      onSort={view.onSort} padding={SUB_TH_PAD} className="font-medium" />
  );
  return (
    <>
      {report.failures.length > SEARCH_FROM_ROWS && (
        <div className="mb-2">
          <TableSearch value={view.search} onChange={view.setSearch} placeholder="Search failure, MX or IP…" testId={`tls-failures-search-${report.id}`} />
        </div>
      )}
      <table className="min-w-full text-left text-xs">
        <thead>
          <tr className="text-gray-500 dark:text-gray-400">
            {header('Failure', 'resultType')}
            {header('Sessions', 'failedSessionCount')}
            {header('Receiving MX', 'receivingMxHostname')}
            {header('Sending IP', 'sendingMtaIp')}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((f, i) => (
            <tr key={`${f.resultType}-${f.receivingMxHostname ?? ''}-${f.sendingMtaIp ?? ''}-${i}`} className="text-gray-800 dark:text-gray-200">
              <td className="py-0.5 pr-4 font-mono">{f.resultType}</td>
              <td className="py-0.5 pr-4 tabular-nums">{f.failedSessionCount}</td>
              <td className="py-0.5 pr-4 font-mono">{f.receivingMxHostname ?? '—'}</td>
              <td className="py-0.5 font-mono">{f.sendingMtaIp ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <TablePager view={view} testIdPrefix={`tls-failures-${report.id}-`} />
    </>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function Row({ report }: { report: TlsReport }) {
  const [open, setOpen] = useState(false);
  const failing = report.failedSessions > 0;
  return (
    <>
      <tr
        className="cursor-pointer border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40"
        onClick={() => setOpen((v) => !v)}
        data-testid={`tls-row-${report.id}`}
      >
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {failing
              ? <LockOpen size={14} className="text-amber-600 dark:text-amber-400" />
              : <Lock size={14} className="text-green-600 dark:text-green-400" />}
          </span>
        </td>
        <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">
          {report.policyDomain ?? <span className="italic text-gray-400">not stated</span>}
        </td>
        <td className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300">
          {report.orgName ?? <span className="italic text-gray-400">unknown reporter</span>}
        </td>
        <td className="px-3 py-2 text-sm tabular-nums text-gray-700 dark:text-gray-300">
          {report.successfulSessions.toLocaleString()}
        </td>
        <td className={`px-3 py-2 text-sm tabular-nums ${failing ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'}`}>
          {report.failedSessions.toLocaleString()}
        </td>
        <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">{formatWhen(report.receivedAt)}</td>
      </tr>
      {open && (
        <tr className="border-t border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40">
          <td colSpan={6} className="px-6 py-3">
            {report.failures.length === 0 ? (
              <p className="text-xs text-gray-600 dark:text-gray-400">
                No failures reported. Every session this reporter opened to us negotiated TLS.
              </p>
            ) : (
              <FailureTable report={report} />
            )}
            {report.contactInfo && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Reporter contact: <span className="font-mono">{report.contactInfo}</span>
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function TlsReportsSection() {
  const [windowDays, setWindowDays] = useState(30);
  const [failingOnly, setFailingOnly] = useState(false);
  const { data, isLoading, isError, error } = useTlsReports(windowDays, failingOnly);
  const overview = data?.data;

  return (
    <section
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4"
      data-testid="tls-reports-section"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Lock size={20} className="text-gray-700 dark:text-gray-300" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Inbound TLS reports</h3>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <input
              type="checkbox"
              checked={failingOnly}
              onChange={(e) => setFailingOnly(e.target.checked)}
              className="accent-brand-500"
              data-testid="tls-failing-only"
            />
            Failures only
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            Window
            <select
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-900 dark:bg-gray-700 dark:text-gray-100"
              data-testid="tls-window-select"
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
        </div>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Other providers report daily on whether they could deliver to this platform over TLS,
        because every mail domain publishes a <code>TLS-RPT</code> record pointing at{' '}
        <code>{overview?.intakeLocalPart ?? 'postmaster'}@</code>. A failure here is ours to fix —
        an expired certificate, a stale MX, or an MTA-STS policy that no longer matches.
      </p>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={16} className="animate-spin" /> Loading reports…
        </div>
      )}

      {isError && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Could not load TLS reports: {(error as Error)?.message ?? 'unknown error'}
        </p>
      )}

      {overview && (
        <div className="flex flex-wrap gap-6 rounded-lg bg-gray-50 dark:bg-gray-900/40 p-3" data-testid="tls-totals">
          <Stat
            label="Successful sessions"
            value={overview.totalSuccessfulSessions.toLocaleString()}
          />
          <Stat
            label="Failed sessions"
            value={overview.totalFailedSessions.toLocaleString()}
            emphasis={overview.totalFailedSessions > 0}
          />
          <Stat
            label="Success rate"
            // Null means no sessions were reported at all. Rendering that as
            // 100% would turn "nothing happened" into "everything is fine".
            value={overview.successRate === null
              ? 'no data'
              : `${(overview.successRate * 100).toFixed(2)}%`}
          />
        </div>
      )}

      {overview && overview.reports.length === 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {failingOnly
            ? `No TLS failures reported in the last ${overview.windowDays} days.`
            : `No TLS reports in the last ${overview.windowDays} days. Reports only arrive from providers that sent you mail and support TLS-RPT, so an empty list is not a fault.`}
        </p>
      )}

      {overview && overview.reports.length > 0 && <ReportsTable overview={overview} />}
    </section>
  );
}

function ReportsTable({ overview }: { readonly overview: TlsReportsOverview }) {
  const view = useTableView(overview.reports, {
    searchText: reportText, defaultSortKey: 'receivedAt', defaultDirection: 'desc', accessors: REPORT_SORT,
  });
  const header = (label: string, key: string) => (
    <SortableHeader label={label} sortKey={key} currentKey={view.sortKey} direction={view.sortDirection}
      onSort={view.onSort} padding={TH_PAD} className={TH} />
  );
  return (
    <>
      <TableSearch value={view.search} onChange={view.setSearch} placeholder="Search domain, reporter, MX…" testId="tls-search" />
      <div className="overflow-x-auto">
        <table className="min-w-full text-left">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {header('TLS', 'tls')}
              {header('Domain', 'policyDomain')}
              {header('Reported by', 'orgName')}
              {header('OK', 'successfulSessions')}
              {header('Failed', 'failedSessions')}
              {header('Received', 'receivedAt')}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => <Row key={r.id} report={r} />)}
            {view.rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-4 text-center text-sm text-gray-500 dark:text-gray-400">No report matches “{view.search}”.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <TablePager view={view} testIdPrefix="tls-" />
      {overview.total > overview.reports.length && (
        <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Info size={13} />
          Showing the {overview.reports.length} most recent of {overview.total} in this window.
        </p>
      )}
    </>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${emphasis ? 'text-amber-700 dark:text-amber-300' : 'text-gray-900 dark:text-gray-100'}`}>
        {value}
      </div>
    </div>
  );
}
