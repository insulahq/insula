/**
 * DMARC results for ONE of the tenant's own email domains.
 *
 * The platform has been collecting these reports per tenant for months and
 * showing them only to the operator — so the domain owner, the one person who
 * can actually fix an unaligned sender, could not see that anything was wrong.
 *
 * Deliberately different from the operator's view, not a copy of it:
 *
 *  - Scoped to the selected domain. A tenant is not auditing an estate; they
 *    want to know whether *their* mail authenticates.
 *  - Sources are expanded, not behind a disclosure. With one domain there is
 *    nothing to compare, and the failing-source list is the actionable half.
 *  - Every rate carries its denominator, and "no reports" is stated as
 *    unknown rather than drawn as 0% or 100% — both of which would be read as
 *    a verdict the data does not support.
 *  - The published policy is described, not just printed as `p=quarantine`.
 *    This audience did not choose the record and mostly does not maintain it.
 */
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, Info, Loader2, ExternalLink, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import type { DmarcOverview, DmarcDomainSummary, DmarcSourceSummary } from '@insula/api-contracts';

interface DmarcTabProps {
  readonly tenantId: string;
  readonly domainName: string;
}

function useTenantDmarc(tenantId: string) {
  return useQuery({
    queryKey: ['tenant-dmarc', tenantId],
    queryFn: () => apiFetch<{ data: DmarcOverview }>(`/api/v1/tenants/${tenantId}/mail/dmarc`),
    staleTime: 60_000,
  });
}

function useTenantDmarcSources(tenantId: string, domain: string | null) {
  return useQuery({
    queryKey: ['tenant-dmarc', tenantId, 'sources', domain],
    queryFn: () =>
      apiFetch<{ data: { sources: readonly DmarcSourceSummary[] } }>(
        `/api/v1/tenants/${tenantId}/mail/dmarc/sources?domain=${encodeURIComponent(domain ?? '')}`,
      ),
    enabled: domain !== null,
    staleTime: 60_000,
  });
}

const TH = 'px-3 py-2 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400';
const TD = 'px-3 py-2 text-sm text-gray-700 dark:text-gray-300';

/** What the published policy tells receivers to DO — in words, not syntax. */
const POLICY_COPY: Record<string, { readonly label: string; readonly detail: string; readonly cls: string }> = {
  none: {
    label: 'Monitor only',
    detail: 'Receivers accept mail that fails the check, and just report it. Safe while you find unaligned senders.',
    cls: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  },
  quarantine: {
    label: 'Quarantine failures',
    detail: 'Mail claiming to be from this domain that fails the check is treated as suspicious — usually filed as spam.',
    cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  },
  reject: {
    label: 'Reject failures',
    detail: 'Mail claiming to be from this domain that fails the check is refused outright. Strongest protection against forgery.',
    cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  },
};

function PassRate({ rate, total }: { readonly rate: number | null; readonly total: number }) {
  // Null means no denominator. 0% and 100% are both claims the data cannot
  // support, and both would be acted on.
  if (rate === null || total === 0) {
    return <span className="text-gray-400 dark:text-gray-500">not enough data</span>;
  }
  const pct = rate * 100;
  const tone =
    pct >= 99
      ? 'text-emerald-600 dark:text-emerald-400'
      : pct >= 90
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-red-600 dark:text-red-400';
  return (
    <span className={tone}>
      {pct.toFixed(1)}%
      <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
        of {total.toLocaleString()} {total === 1 ? 'message' : 'messages'}
      </span>
    </span>
  );
}

function SourceTable({ tenantId, domain }: { readonly tenantId: string; readonly domain: string }) {
  const q = useTenantDmarcSources(tenantId, domain);

  if (q.isLoading) {
    return (
      <div className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 size={14} className="mr-1.5 inline animate-spin" />
        Loading senders…
      </div>
    );
  }
  if (q.isError) {
    // Loud, not empty. An error that renders as an empty table says "nobody
    // sent as your domain", which is the one wrong answer this page can give.
    return (
      <div
        className="flex items-start gap-2 px-3 py-4 text-sm text-red-600 dark:text-red-400"
        data-testid="dmarc-tenant-sources-error"
      >
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
        <span>
          Could not load the sender list. This is a loading failure, not an empty result — reload
          the page to try again.
        </span>
      </div>
    );
  }

  const rows = q.data?.data.sources ?? [];
  if (rows.length === 0) {
    return (
      <div className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
        No individual senders reported in this window.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full" data-testid="dmarc-tenant-sources">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700">
            <th className={TH}>Sending server</th>
            <th className={TH}>Messages</th>
            <th className={TH}>Passing</th>
            <th className={TH}>Failing</th>
            <th className={TH}>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.sourceIp}
              className="border-b border-gray-100 dark:border-gray-700/50"
              data-testid={`dmarc-source-${r.sourceIp}`}
            >
              <td className={`${TD} font-mono text-xs`}>{r.sourceIp}</td>
              <td className={TD}>{r.messageCount.toLocaleString()}</td>
              <td className={`${TD} text-emerald-600 dark:text-emerald-400`}>
                {r.passCount.toLocaleString()}
              </td>
              <td className={`${TD} ${r.failCount > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
                {r.failCount.toLocaleString()}
              </td>
              <td className={TD}>
                {r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleDateString() : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DmarcTab({ tenantId, domainName }: DmarcTabProps) {
  const q = useTenantDmarc(tenantId);

  if (q.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div
        className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        data-testid="dmarc-tenant-error"
      >
        <AlertCircle size={16} className="mt-0.5 shrink-0" />
        <span>
          Could not load authentication reports for this domain. Nothing here should be read as a
          result — reload the page to try again.
        </span>
      </div>
    );
  }

  const overview = q.data?.data;
  const windowDays = overview?.windowDays ?? 30;
  // Reports are keyed by the policy domain the receiver resolved, which is the
  // domain name — match on it rather than assuming the list has one entry, since
  // a tenant with several email domains gets several.
  const summary: DmarcDomainSummary | undefined = overview?.domains.find(
    (d) => d.policyDomain.toLowerCase() === domainName.toLowerCase(),
  );

  return (
    <div className="space-y-4" data-testid="dmarc-tenant-tab">
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck size={18} className="text-brand-500" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Email authentication for {domainName}
          </h3>
          <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
            last {windowDays} days
          </span>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Mail providers that receive mail claiming to be from{' '}
          <span className="font-medium text-gray-900 dark:text-gray-100">{domainName}</span> send
          back daily reports on whether it passed authentication (SPF and DKIM). Failures mean
          either one of your own senders is misconfigured, or somebody else is sending as your
          domain.
        </p>

        {!summary ? (
          // NOT an all-clear. No reports can equally mean nothing has been sent,
          // or that the reporting address is not receiving — which is the exact
          // state this platform sat in before the intake mailbox existed.
          <div
            className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
            data-testid="dmarc-tenant-empty"
          >
            <Info size={14} className="mr-1.5 inline text-gray-500" />
            No reports received for this domain yet — which is not the same as &ldquo;everything
            passes&rdquo;. Providers only report once they have seen mail from this domain, and the
            first reports normally arrive within 24–48 hours of the first send.
          </div>
        ) : (
          <>
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Passing authentication
                </dt>
                <dd className="mt-1 text-sm" data-testid="dmarc-tenant-pass-rate">
                  <PassRate rate={summary.passRate} total={summary.totalMessages} />
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Failing senders
                </dt>
                <dd className="mt-1 text-sm" data-testid="dmarc-tenant-failing">
                  {summary.failingSources > 0 ? (
                    <span className="text-red-600 dark:text-red-400">
                      {summary.failingSources} {summary.failingSources === 1 ? 'server' : 'servers'}
                    </span>
                  ) : (
                    <span className="text-gray-500 dark:text-gray-400">none</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Reports received
                </dt>
                <dd className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                  {summary.reportCount.toLocaleString()}
                  {summary.lastReportAt && (
                    <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
                      last {new Date(summary.lastReportAt).toLocaleDateString()}
                    </span>
                  )}
                </dd>
              </div>
            </dl>

            <div className="rounded-md border border-gray-200 p-3 dark:border-gray-700">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Current policy
                </span>
                {summary.currentPolicy ? (
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${POLICY_COPY[summary.currentPolicy].cls}`}
                    data-testid="dmarc-tenant-policy"
                  >
                    {POLICY_COPY[summary.currentPolicy].label}
                  </span>
                ) : (
                  <span className="text-sm text-gray-500 dark:text-gray-400" data-testid="dmarc-tenant-policy">
                    not published
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-400">
                {summary.currentPolicy
                  ? POLICY_COPY[summary.currentPolicy].detail
                  : 'Receivers have no instructions for mail that fails the check, so forged mail is treated like any other message.'}
              </p>
              <p className="mt-2 flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-400">
                {summary.recommendation.ready ? (
                  <ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <ShieldAlert size={13} className="mt-0.5 shrink-0 text-gray-500 dark:text-gray-400" />
                )}
                <span data-testid="dmarc-tenant-recommendation">
                  {summary.recommendation.reason} The <code className="font-mono">_dmarc</code>{' '}
                  record is maintained for you — contact support if you want the policy changed.
                </span>
              </p>
            </div>
          </>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <ExternalLink size={16} className="text-gray-500 dark:text-gray-400" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Who sent as {domainName}
          </h3>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Every server that receivers saw sending as this domain, worst first. A server with
          failures is either one of yours that needs its SPF or DKIM fixed, or one that should not
          be sending as you at all.
        </p>
        <div className="rounded-lg border border-gray-200 dark:border-gray-700">
          <SourceTable tenantId={tenantId} domain={domainName} />
        </div>
      </div>
    </div>
  );
}
