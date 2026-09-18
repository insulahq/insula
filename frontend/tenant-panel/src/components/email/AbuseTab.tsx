/**
 * Abuse reports about this tenant's mail.
 *
 * A complaint about your domain is your problem to fix, and you cannot fix
 * what you cannot see — the platform ingested these and showed them only to
 * the operator, which is the same gap the DMARC tab next door closed.
 *
 * Framed for the domain owner rather than the operator: what was complained
 * about, which of your addresses sent it, and what to do. No estate-wide
 * counts, and no tenant column — every row here is already yours.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, Inbox, Loader2, ChevronRight, ChevronDown } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import type { AbuseReportsOverview, AbuseReport, AbuseFeedbackType } from '@insula/api-contracts';

const TYPE_STYLE: Record<AbuseFeedbackType, { label: string; cls: string }> = {
  abuse: { label: 'Abuse', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  fraud: { label: 'Fraud', cls: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
  virus: { label: 'Virus', cls: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
  other: { label: 'Other', cls: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' },
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Detail({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 font-medium text-gray-500 dark:text-gray-400">{label}:</dt>
      <dd className={`break-all text-gray-800 dark:text-gray-200 ${mono ? 'font-mono' : ''}`}>
        {value ?? <span className="italic text-gray-400">not stated</span>}
      </dd>
    </div>
  );
}

function Row({ report }: { report: AbuseReport }) {
  const [open, setOpen] = useState(false);
  const style = TYPE_STYLE[report.feedbackType] ?? TYPE_STYLE.other;
  return (
    <>
      <tr
        className="cursor-pointer border-t border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40"
        onClick={() => setOpen((v) => !v)}
        data-testid={`tenant-abuse-row-${report.id}`}
      >
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${style.cls}`}>{style.label}</span>
          </span>
        </td>
        <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">
          {report.originalMailFrom ?? report.domain ?? <span className="italic text-gray-400">not stated</span>}
        </td>
        <td className="px-3 py-2 text-sm tabular-nums text-gray-700 dark:text-gray-300">
          {report.incidents > 1 ? `${report.incidents}×` : '1'}
        </td>
        <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">{formatWhen(report.receivedAt)}</td>
      </tr>
      {open && (
        <tr className="border-t border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40">
          <td colSpan={4} className="px-6 py-3">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-xs sm:grid-cols-2">
              <Detail label="Reported by" value={report.reporter} />
              <Detail label="Reporting server" value={report.reportingMta} />
              <Detail label="Your sending address" value={report.originalMailFrom} mono />
              <Detail label="Recipient who complained" value={report.originalRcptTo} mono />
              <Detail label="Sending IP" value={report.sourceIp} mono />
              <Detail label="Subject" value={report.subject} />
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

export default function AbuseTab({ tenantId }: { tenantId: string }) {
  const [windowDays, setWindowDays] = useState(30);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tenant', tenantId, 'mail', 'abuse-reports', windowDays],
    queryFn: () => apiFetch<{ data: AbuseReportsOverview }>(
      `/api/v1/tenants/${tenantId}/mail/abuse-reports?windowDays=${windowDays}`,
    ),
    staleTime: 60_000,
  });
  const overview = data?.data;

  return (
    <section className="space-y-4" data-testid="tenant-abuse-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ShieldAlert size={20} className="text-gray-700 dark:text-gray-300" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Abuse reports</h3>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          Window
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-900 dark:bg-gray-700 dark:text-gray-100"
            data-testid="tenant-abuse-window-select"
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        When another mail provider receives a complaint about a message from one of your
        addresses, it can send a machine-readable report. Those are shown here. Repeated
        complaints damage your domain&apos;s reputation and can get your mail blocked, so treat
        each one as something to fix at the source.
      </p>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={16} className="animate-spin" /> Loading reports…
        </div>
      )}

      {isError && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Could not load abuse reports: {(error as Error)?.message ?? 'unknown error'}
        </p>
      )}

      {overview && overview.reports.length === 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-gray-50 dark:bg-gray-900/40 p-3 text-sm text-gray-600 dark:text-gray-400">
          <Inbox size={16} className="mt-0.5 shrink-0" />
          <span>
            No abuse reports in the last {overview.windowDays} days. This is the normal state —
            reports only arrive when a recipient marks one of your messages as spam or abuse.
          </span>
        </div>
      )}

      {overview && overview.reports.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Sent from</th>
                <th className="px-3 py-2 font-medium">Incidents</th>
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
