import { useQuery } from '@tanstack/react-query';
import { Mail, Loader2, AlertCircle, ShieldCheck, ShieldAlert, ShieldOff } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { Link } from 'react-router-dom';
import type { MailOverviewResponse, ComplaintSummaryEntry } from '@insula/api-contracts';

/**
 * Monitoring → Mail (PR 5): send stats, top senders, complaints,
 * live outbound queue, and the sending-protection status.
 */

function useMailOverview() {
  return useQuery({
    queryKey: ['mail-overview'],
    queryFn: () => apiFetch<{ data: MailOverviewResponse }>('/api/v1/admin/mail/overview'),
    refetchInterval: 60_000,
  });
}

function useComplaintSummary() {
  return useQuery({
    queryKey: ['mail-complaint-summary'],
    queryFn: () => apiFetch<{ data: ComplaintSummaryEntry[] }>('/api/v1/admin/mail/complaints/summary'),
    refetchInterval: 120_000,
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

function ratePct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

const TH_CLS = 'py-2 pr-4 text-left text-xs font-medium text-gray-500 dark:text-gray-400';
const TD_CLS = 'py-2 pr-4 text-sm text-gray-700 dark:text-gray-300';

export default function MailTab() {
  const overview = useMailOverview();
  const complaints = useComplaintSummary();
  const data = overview.data?.data;
  const summary = complaints.data?.data ?? [];

  if (overview.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={20} className="animate-spin text-brand-500" />
      </div>
    );
  }

  if (overview.isError || !data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5 text-sm text-red-700 dark:text-red-300">
        <AlertCircle size={14} className="inline mr-1.5" />
        Failed to load mail overview
        {overview.error instanceof Error ? `: ${overview.error.message}` : ''}
      </div>
    );
  }

  const flagged = summary.filter((s) => s.complaints7d > 0);
  const modeBadge = data.protection.mode === 'auto'
    ? { icon: ShieldCheck, text: 'Automatic enforcement', cls: 'text-emerald-600 dark:text-emerald-400' }
    : data.protection.mode === 'notify'
      ? { icon: ShieldAlert, text: 'Notify only', cls: 'text-amber-600 dark:text-amber-400' }
      : { icon: ShieldOff, text: 'Protection off', cls: 'text-red-600 dark:text-red-400' };
  const ModeIcon = modeBadge.icon;

  return (
    <div className="space-y-5" data-testid="mail-tab">
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
        <StatCard label="Sent today" value={data.totals.sentToday} />
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

      {/* Complaints */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">FBL complaints</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          7-day complaint rate = complaints ÷ sends. &gt;0.1% is throttle territory, &gt;0.3% suspend territory.
        </p>
        {flagged.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No complaints in the last 30 days.</p>
        ) : (
          <table className="w-full" data-testid="complaints-table">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700">
                <th className={TH_CLS}>Domain</th>
                <th className={TH_CLS}>Tenant</th>
                <th className={TH_CLS}>7d rate</th>
                <th className={TH_CLS}>7d (c/s)</th>
                <th className={TH_CLS}>30d rate</th>
                <th className={TH_CLS}>Last complaint</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map((s) => {
                const danger = s.complaintRate7d > 0.003;
                const warn = !danger && s.complaintRate7d > 0.001;
                return (
                  <tr key={`${s.tenantId}|${s.domain}`} className="border-b border-gray-50 dark:border-gray-700/50">
                    <td className={`${TD_CLS} font-medium text-gray-900 dark:text-gray-100`}>{s.domain ?? '—'}</td>
                    <td className={TD_CLS}>{s.tenantName ?? s.tenantId ?? 'unattributed'}</td>
                    <td className={`${TD_CLS} font-semibold ${danger ? 'text-red-600 dark:text-red-400' : warn ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                      {ratePct(s.complaintRate7d)}
                    </td>
                    <td className={TD_CLS}>{s.complaints7d}/{s.sent7d}</td>
                    <td className={TD_CLS}>{ratePct(s.complaintRate30d)}</td>
                    <td className={TD_CLS}>{s.lastComplaintAt ? new Date(s.lastComplaintAt).toLocaleString() : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Top senders */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Most active senders (7d)</h3>
        {data.topSenders.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No outbound mail recorded yet.</p>
        ) : (
          <table className="w-full" data-testid="top-senders-table">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700">
                <th className={TH_CLS}>Domain</th>
                <th className={TH_CLS}>Tenant</th>
                <th className={TH_CLS}>24h</th>
                <th className={TH_CLS}>7d</th>
                <th className={TH_CLS}>Deferred</th>
                <th className={TH_CLS}>Rejected</th>
              </tr>
            </thead>
            <tbody>
              {data.topSenders.map((s) => (
                <tr key={`${s.tenantId}|${s.domain}`} className="border-b border-gray-50 dark:border-gray-700/50">
                  <td className={`${TD_CLS} font-medium text-gray-900 dark:text-gray-100`}>{s.domain}</td>
                  <td className={TD_CLS}>{s.tenantName ?? s.tenantId}</td>
                  <td className={TD_CLS}>{s.sent24h}</td>
                  <td className={TD_CLS}>{s.sent7d}</td>
                  <td className={`${TD_CLS} ${s.rateLimited7d > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{s.rateLimited7d}</td>
                  <td className={`${TD_CLS} ${s.quotaRejected7d > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{s.quotaRejected7d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Queue */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Outbound queue {data.queue.reachable ? `(${data.queue.depth}${data.queue.depth === 50 ? '+' : ''})` : ''}
          </h3>
          {!data.queue.reachable && (
            <span className="text-xs text-red-600 dark:text-red-400">mail server unreachable</span>
          )}
        </div>
        {data.queue.entries.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {data.queue.reachable ? 'Queue is empty — all outbound mail delivered.' : 'Queue state unavailable.'}
          </p>
        ) : (
          <table className="w-full" data-testid="mail-queue-table">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700">
                <th className={TH_CLS}>From</th>
                <th className={TH_CLS}>Recipients</th>
                <th className={TH_CLS}>Queued</th>
                <th className={TH_CLS}>Next retry</th>
              </tr>
            </thead>
            <tbody>
              {data.queue.entries.map((m) => (
                <tr key={m.id} className="border-b border-gray-50 dark:border-gray-700/50">
                  <td className={`${TD_CLS} font-mono text-xs`}>{m.from || '<>'}</td>
                  <td className={`${TD_CLS} font-mono text-xs`}>{m.recipients.join(', ')}</td>
                  <td className={TD_CLS}>{m.createdAt ? new Date(m.createdAt).toLocaleString() : '—'}</td>
                  <td className={TD_CLS}>{m.nextRetry ? new Date(m.nextRetry).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
