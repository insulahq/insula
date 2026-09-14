/**
 * DMARC aggregate reports (ROADMAP R5).
 *
 * Answers the two questions an operator has about DMARC:
 *
 *   1. Is our mail authenticating? — per domain, always WITH the denominator.
 *      A pass rate on its own is the figure that gets acted on when it should
 *      not be: "100%" over eleven messages is one quiet week, not evidence.
 *   2. Who is failing? — per source IP, ordered by failing messages rather than
 *      by volume, because the biggest sender is rarely the problem and sorting
 *      by volume buries the one misconfigured host.
 *
 * Nothing here changes a published policy. `p=reject` on a domain with one
 * legitimate unaligned sender stops that sender's mail immediately rather than
 * degrading, so the tightening stays an operator decision.
 */
import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, Info, Loader2, ChevronRight, ChevronDown } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import type { DmarcOverview, DmarcDomainSummary, DmarcSourceSummary } from '@insula/api-contracts';

function useDmarcOverview() {
  return useQuery({
    queryKey: ['mail', 'dmarc'],
    queryFn: () => apiFetch<{ data: DmarcOverview }>('/api/v1/admin/mail/dmarc'),
    staleTime: 60_000,
  });
}

function useDmarcSources(domain: string | null) {
  return useQuery({
    queryKey: ['mail', 'dmarc', 'sources', domain],
    queryFn: () => apiFetch<{ data: DmarcSourceSummary[] }>(
      `/api/v1/admin/mail/dmarc/sources?domain=${encodeURIComponent(domain ?? '')}`,
    ),
    enabled: domain !== null,
    staleTime: 60_000,
  });
}

const TH = 'px-3 py-2 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400';
const TD = 'px-3 py-2 text-sm text-gray-700 dark:text-gray-300';

/**
 * Render a pass rate, or say plainly that there isn't one.
 *
 * `null` means no messages were reported. Showing 0% (catastrophe) or 100%
 * (all clear) would both be claims the data does not support, and either would
 * be acted on.
 */
function PassRate({ rate, total }: { rate: number | null; total: number }) {
  if (rate === null || total === 0) {
    return <span className="text-gray-400 dark:text-gray-500">no data</span>;
  }
  const pct = rate * 100;
  const tone = pct >= 99 ? 'text-emerald-600 dark:text-emerald-400'
    : pct >= 90 ? 'text-amber-600 dark:text-amber-400'
      : 'text-red-600 dark:text-red-400';
  return (
    <span className={tone}>
      {pct.toFixed(1)}%
      <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">of {total.toLocaleString()}</span>
    </span>
  );
}

function PolicyBadge({ policy }: { policy: string | null }) {
  if (!policy) return <span className="text-gray-400 dark:text-gray-500">not published</span>;
  const cls = policy === 'reject' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
    : policy === 'quarantine' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
      : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200';
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>p={policy}</span>;
}

function SourceTable({ domain }: { domain: string }) {
  const q = useDmarcSources(domain);
  if (q.isLoading) {
    return <div className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={14} className="mr-1.5 inline animate-spin" />Loading sources…</div>;
  }
  const rows = q.data?.data ?? [];
  if (rows.length === 0) {
    return <div className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">No per-source rows in this window.</div>;
  }
  return (
    <table className="w-full" data-testid={`dmarc-sources-${domain}`}>
      <thead>
        <tr className="border-b border-gray-200 dark:border-gray-700">
          <th className={TH}>Source IP</th><th className={TH}>Messages</th>
          <th className={TH}>Passing</th><th className={TH}>Failing</th><th className={TH}>Last seen</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.sourceIp} className="border-b border-gray-100 dark:border-gray-700/50">
            <td className={`${TD} font-mono text-xs`}>{r.sourceIp}</td>
            <td className={TD}>{r.messageCount.toLocaleString()}</td>
            <td className={`${TD} text-emerald-600 dark:text-emerald-400`}>{r.passCount.toLocaleString()}</td>
            <td className={`${TD} ${r.failCount > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{r.failCount.toLocaleString()}</td>
            <td className={TD}>{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleDateString() : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function DmarcSection() {
  const q = useDmarcOverview();
  const [open, setOpen] = useState<string | null>(null);

  if (q.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <Loader2 size={18} className="animate-spin text-brand-500" />
      </div>
    );
  }

  const data = q.data?.data;
  const domains: readonly DmarcDomainSummary[] = data?.domains ?? [];

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck size={18} className="text-brand-500" />
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">DMARC aggregate reports</h3>
        {data && (
          <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">last {data.windowDays} days</span>
        )}
      </div>

      {domains.length === 0 ? (
        // Not an all-clear. No reports can mean mail is perfect, or that the
        // published rua= address is not receiving — which is exactly the state
        // this platform was in before R5 (the record pointed at a mailbox that
        // never existed), and nothing surfaced it.
        <div
          className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
          data-testid="dmarc-empty"
        >
          <Info size={14} className="mr-1.5 inline text-gray-500" />
          No DMARC reports received yet. This is not the same as "everything passes" — receivers
          only send reports to the <code>rua=</code> address published in each domain's
          <code> _dmarc</code> record, which the platform points at
          {' '}<code>{data?.intakeLocalPart ?? 'dmarc'}@&lt;domain&gt;</code>. Reports normally begin
          arriving within 24–48 hours of publishing the record.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full" data-testid="dmarc-domains">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className={TH}>Domain</th>
                <th className={TH}>DMARC pass rate</th>
                <th className={TH}>Published</th>
                <th className={TH}>Failing sources</th>
                <th className={TH}>Reports</th>
                <th className={TH}>Recommendation</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <Fragment key={d.policyDomain}>
                  <tr
                    className="cursor-pointer border-b border-gray-100 hover:bg-gray-50 dark:border-gray-700/50 dark:hover:bg-gray-700/30"
                    onClick={() => setOpen(open === d.policyDomain ? null : d.policyDomain)}
                  >
                    <td className={`${TD} font-medium text-gray-900 dark:text-gray-100`}>
                      {open === d.policyDomain
                        ? <ChevronDown size={13} className="mr-1 inline" />
                        : <ChevronRight size={13} className="mr-1 inline" />}
                      {d.policyDomain}
                    </td>
                    <td className={TD}><PassRate rate={d.passRate} total={d.totalMessages} /></td>
                    <td className={TD}><PolicyBadge policy={d.currentPolicy} /></td>
                    <td className={TD}>
                      {d.failingSources > 0
                        ? <span className="text-red-600 dark:text-red-400">{d.failingSources}</span>
                        : <span className="text-gray-400 dark:text-gray-500">none</span>}
                    </td>
                    <td className={TD}>{d.reportCount}</td>
                    <td className={TD}>
                      {/* Gated on `ready`, not on recommendedPolicy != null, so a
                          null-because-unknown cannot render as a green go-ahead. */}
                      {d.recommendation.ready ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <ShieldCheck size={13} />
                          move to p={d.recommendation.recommendedPolicy}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
                          <ShieldAlert size={13} />
                          keep observing
                        </span>
                      )}
                    </td>
                  </tr>
                  {open === d.policyDomain && (
                    <tr className="bg-gray-50/60 dark:bg-gray-900/30">
                      <td colSpan={6} className="px-3 py-3">
                        <p className="mb-3 text-sm text-gray-700 dark:text-gray-300" data-testid={`dmarc-reason-${d.policyDomain}`}>
                          {d.recommendation.reason}
                        </p>
                        <div className="overflow-x-auto rounded border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                          <SourceTable domain={d.policyDomain} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
