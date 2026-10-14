import { useQuery } from '@tanstack/react-query';
import { Mail, Loader2, AlertCircle, ShieldAlert, ShieldOff } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import DmarcSection from './DmarcSection';
import AbuseReportsSection from './AbuseReportsSection';
import TlsReportsSection from './TlsReportsSection';
import MailHealthBanner from '@/components/MailHealthBanner';
import SortableHeader from '@/components/ui/SortableHeader';
import TableSearch from '@/components/ui/TableSearch';
import TablePager from '@/components/ui/TablePager';
import { useTableView } from '@/hooks/use-table-view';
import type { SortAccessors } from '@/hooks/use-sortable';
import { Link } from 'react-router-dom';
import type { MailOverviewResponse } from '@insula/api-contracts';

/**
 * Monitoring → Mail: the mail server's live health checks, send stats, every
 * sending domain, the live outbound queue, DMARC, abuse and TLS reports, and
 * the sending-protection status.
 *
 * The health banner heads the page because the mail-health, blocklist and
 * deliverability notifications open it — the check that fired has to be the
 * first thing on the page they land on.
 *
 * The FBL complaints table was removed with the FBL retirement —
 * it had never had a row to show.
 */

type Sender = MailOverviewResponse['topSenders'][number];
type Queued = MailOverviewResponse['queue']['entries'][number];

const senderText = (s: Sender): string => `${s.domain} ${s.tenantName ?? s.tenantId}`;
const SENDER_SORT: SortAccessors<Sender> = { tenant: (s) => s.tenantName ?? s.tenantId };

const queuedText = (m: Queued): string => `${m.from} ${m.recipients.join(' ')}`;
const QUEUE_SORT: SortAccessors<Queued> = {
  recipients: (m) => m.recipients[0] ?? null,
  // ISO instants sort as text in time order; a missing one sorts last.
  createdAt: (m) => m.createdAt,
  nextRetry: (m) => m.nextRetry,
};

function useMailOverview() {
  return useQuery({
    queryKey: ['mail-overview'],
    queryFn: () => apiFetch<{ data: MailOverviewResponse }>('/api/v1/admin/mail/overview'),
    refetchInterval: 60_000,
  });
}

function StatCard({ label, value, accent }: {
  readonly label: string;
  readonly value: string | number;
  readonly accent?: 'amber' | 'red';
}) {
  const valueCls = accent === 'red'
    ? 'text-red-600 dark:text-red-400'
    : accent === 'amber'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-gray-900 dark:text-gray-100';
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${valueCls}`}>{value}</p>
    </div>
  );
}


const TH_CLS = 'text-left text-xs font-medium text-gray-500 dark:text-gray-400';
const TH_PAD = 'py-2 pr-4';
const TD_CLS = 'py-2 pr-4 text-sm text-gray-700 dark:text-gray-300';

export default function MailTab() {
  const overview = useMailOverview();
  const data = overview.data?.data;

  return (
    <div className="space-y-5 p-5" data-testid="mail-tab">
      {/* Shown whatever the overview does: it probes the mail server itself,
          and a failed overview is exactly when the checks matter. */}
      <MailHealthBanner />
      {overview.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={20} className="animate-spin text-brand-500" />
        </div>
      ) : overview.isError || !data ? (
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5 text-sm text-red-700 dark:text-red-300">
          <AlertCircle size={14} className="inline mr-1.5" />
          Failed to load mail overview
          {overview.error instanceof Error ? `: ${overview.error.message}` : ''}
        </div>
      ) : (
        <MailOverview data={data} />
      )}

      {/* ROADMAP R5 */}
      <DmarcSection />
      <AbuseReportsSection />
      <TlsReportsSection />
    </div>
  );
}

function MailOverview({ data }: { readonly data: MailOverviewResponse }) {
  const modeBadge = data.protection.mode === 'notify'
    ? { icon: ShieldAlert, text: 'Notify only', cls: 'text-amber-600 dark:text-amber-400' }
    : { icon: ShieldOff, text: 'Protection off', cls: 'text-red-600 dark:text-red-400' };
  const ModeIcon = modeBadge.icon;

  return (
    <>
      {/* Protection status */}
      <div className="flex items-center justify-between rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <Mail size={16} className="text-gray-600 dark:text-gray-400" />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Sending protection</span>
          <span className={`inline-flex items-center gap-1 text-sm font-medium ${modeBadge.cls}`}>
            <ModeIcon size={14} /> {modeBadge.text}
          </span>
        </div>
        <Link
          to="/email/settings"
          className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
          data-testid="mail-protection-settings-link"
        >
          Configure →
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Sent (24h)" value={data.totals.sent24h} />
        <StatCard label="Sent (7d)" value={data.totals.sent7d} />
        <StatCard label="Recipients (7d)" value={data.totals.recipients7d} />
        <StatCard
          label="Rate-deferred (7d)"
          value={data.totals.rateLimited7d}
          accent={data.totals.rateLimited7d > 0 ? 'amber' : undefined}
        />
        <StatCard
          label="Quota-rejected (7d)"
          value={data.totals.quotaRejected7d}
          accent={data.totals.quotaRejected7d > 0 ? 'red' : undefined}
        />
      </div>

      <SendersTable senders={data.topSenders} />
      <QueueTable queue={data.queue} />
    </>
  );
}

function SendersTable({ senders }: { readonly senders: readonly Sender[] }) {
  const view = useTableView(senders, {
    searchText: senderText, defaultSortKey: 'sent7d', defaultDirection: 'desc', accessors: SENDER_SORT,
  });
  const header = (label: string, key: string) => (
    <SortableHeader label={label} sortKey={key} currentKey={view.sortKey} direction={view.sortDirection}
      onSort={view.onSort} padding={TH_PAD} className={TH_CLS} />
  );
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Sending domains (7d)</h3>
        {senders.length > 0 && (
          <TableSearch value={view.search} onChange={view.setSearch} placeholder="Search domain or tenant…" testId="top-senders-search" />
        )}
      </div>
      {senders.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No outbound mail recorded yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="top-senders-table">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700">
                  {header('Domain', 'domain')}
                  {header('Tenant', 'tenant')}
                  {header('24h', 'sent24h')}
                  {header('7d', 'sent7d')}
                  {header('Deferred', 'rateLimited7d')}
                  {header('Rejected', 'quotaRejected7d')}
                </tr>
              </thead>
              <tbody>
                {view.rows.map((s) => (
                  <tr key={`${s.tenantId}|${s.domain}`} className="border-b border-gray-50 dark:border-gray-700/50">
                    <td className={`${TD_CLS} font-medium text-gray-900 dark:text-gray-100`}>{s.domain}</td>
                    <td className={TD_CLS}>{s.tenantName ?? s.tenantId}</td>
                    <td className={TD_CLS}>{s.sent24h}</td>
                    <td className={TD_CLS}>{s.sent7d}</td>
                    <td className={`${TD_CLS} ${s.rateLimited7d > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{s.rateLimited7d}</td>
                    <td className={`${TD_CLS} ${s.quotaRejected7d > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{s.quotaRejected7d}</td>
                  </tr>
                ))}
                {view.rows.length === 0 && (
                  <tr><td colSpan={6} className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">No sending domain matches “{view.search}”.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <TablePager view={view} testIdPrefix="top-senders-" />
        </>
      )}
    </div>
  );
}

function QueueTable({ queue }: { readonly queue: MailOverviewResponse['queue'] }) {
  const view = useTableView(queue.entries, {
    searchText: queuedText, defaultSortKey: 'createdAt', defaultDirection: 'asc', accessors: QUEUE_SORT,
  });
  const header = (label: string, key: string) => (
    <SortableHeader label={label} sortKey={key} currentKey={view.sortKey} direction={view.sortDirection}
      onSort={view.onSort} padding={TH_PAD} className={TH_CLS} />
  );
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Outbound queue {queue.reachable ? `(${queue.depth}${queue.truncated ? '+' : ''})` : ''}
        </h3>
        {!queue.reachable && (
          <span className="text-xs text-red-600 dark:text-red-400">mail server unreachable</span>
        )}
        {queue.entries.length > 0 && (
          <TableSearch value={view.search} onChange={view.setSearch} placeholder="Search sender or recipient…" testId="mail-queue-search" />
        )}
      </div>
      {queue.entries.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {queue.reachable ? 'Queue is empty — all outbound mail delivered.' : 'Queue state unavailable.'}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="mail-queue-table">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700">
                  {header('From', 'from')}
                  {header('Recipients', 'recipients')}
                  {header('Queued', 'createdAt')}
                  {header('Next retry', 'nextRetry')}
                </tr>
              </thead>
              <tbody>
                {view.rows.map((m) => (
                  <tr key={m.id} className="border-b border-gray-50 dark:border-gray-700/50">
                    <td className={`${TD_CLS} font-mono text-xs`}>{m.from || '<>'}</td>
                    <td className={`${TD_CLS} font-mono text-xs`}>{m.recipients.join(', ')}</td>
                    <td className={TD_CLS}>{m.createdAt ? new Date(m.createdAt).toLocaleString() : '—'}</td>
                    <td className={TD_CLS}>{m.nextRetry ? new Date(m.nextRetry).toLocaleString() : '—'}</td>
                  </tr>
                ))}
                {view.rows.length === 0 && (
                  <tr><td colSpan={4} className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">No queued message matches “{view.search}”.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <TablePager view={view} testIdPrefix="mail-queue-" />
        </>
      )}
    </div>
  );
}
