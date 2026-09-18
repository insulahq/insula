/**
 * Inbound TLS reports for this tenant's domain.
 *
 * Distinct from the Authentication tab: that one answers "is my outgoing mail
 * trusted", this one answers "can other providers deliver to me securely".
 * Both matter and neither substitutes for the other, which is why they are not
 * merged — a domain can pass DMARC perfectly while presenting an expired
 * certificate to every sender.
 *
 * Framed as something the tenant can raise rather than fix: the certificate and
 * MX are the platform's, so the action is "tell support", not "edit DNS".
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock, LockOpen, Loader2, ChevronRight, ChevronDown } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import type { TlsReportsOverview, TlsReport } from '@insula/api-contracts';

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function Row({ report }: { report: TlsReport }) {
  const [open, setOpen] = useState(false);
  const failing = report.failedSessions > 0;
  return (
    <>
      <tr
        className="cursor-pointer border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40"
        onClick={() => setOpen((v) => !v)}
        data-testid={`tenant-tls-row-${report.id}`}
      >
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {failing
              ? <LockOpen size={14} className="text-amber-600 dark:text-amber-400" />
              : <Lock size={14} className="text-green-600 dark:text-green-400" />}
          </span>
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
          <td colSpan={5} className="px-6 py-3">
            {report.failures.length === 0 ? (
              <p className="text-xs text-gray-600 dark:text-gray-400">
                No failures — every connection this provider made to your mail server was
                encrypted successfully.
              </p>
            ) : (
              <>
                <table className="min-w-full text-left text-xs">
                  <thead>
                    <tr className="text-gray-500 dark:text-gray-400">
                      <th className="pb-1 pr-4 font-medium">Problem</th>
                      <th className="pb-1 pr-4 font-medium">Sessions</th>
                      <th className="pb-1 font-medium">Your mail server</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.failures.map((f, i) => (
                      <tr key={`${f.resultType}-${i}`} className="text-gray-800 dark:text-gray-200">
                        <td className="py-0.5 pr-4 font-mono">{f.resultType}</td>
                        <td className="py-0.5 pr-4 tabular-nums">{f.failedSessionCount}</td>
                        <td className="py-0.5 font-mono">{f.receivingMxHostname ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Your mail server and its certificate are managed for you — if failures persist,
                  contact support quoting this report.
                </p>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function TlsTab({ tenantId }: { tenantId: string }) {
  const [windowDays, setWindowDays] = useState(30);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tenant', tenantId, 'mail', 'tls-reports', windowDays],
    queryFn: () => apiFetch<{ data: TlsReportsOverview }>(
      `/api/v1/tenants/${tenantId}/mail/tls-reports?windowDays=${windowDays}`,
    ),
    staleTime: 60_000,
  });
  const overview = data?.data;

  return (
    <section className="space-y-4" data-testid="tenant-tls-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Lock size={20} className="text-gray-700 dark:text-gray-300" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Delivery security</h3>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          Window
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-900 dark:bg-gray-700 dark:text-gray-100"
            data-testid="tenant-tls-window-select"
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        When another provider sends mail to your domain, it encrypts the connection. Providers
        report back daily on whether that worked. Failures mean somebody could not reach your
        mailboxes securely — they may have delivered anyway without encryption, or not at all.
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
        <div className="flex flex-wrap gap-6 rounded-lg bg-gray-50 dark:bg-gray-900/40 p-3" data-testid="tenant-tls-totals">
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Encrypted connections</div>
            <div className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
              {overview.totalSuccessfulSessions.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Failed</div>
            <div className={`text-lg font-semibold tabular-nums ${overview.totalFailedSessions > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-gray-900 dark:text-gray-100'}`}>
              {overview.totalFailedSessions.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Success rate</div>
            <div className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
              {overview.successRate === null
                ? 'no data'
                : `${(overview.successRate * 100).toFixed(2)}%`}
            </div>
          </div>
        </div>
      )}

      {overview && overview.reports.length === 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          No reports in the last {overview.windowDays} days. Only some providers send these, so an
          empty list does not mean anything is wrong.
        </p>
      )}

      {overview && overview.reports.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <th className="px-3 py-2 font-medium">TLS</th>
                <th className="px-3 py-2 font-medium">Reported by</th>
                <th className="px-3 py-2 font-medium">Encrypted</th>
                <th className="px-3 py-2 font-medium">Failed</th>
                <th className="px-3 py-2 font-medium">Received</th>
              </tr>
            </thead>
            <tbody>
              {overview.reports.map((r) => <Row key={r.id} report={r} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
