/**
 * Email → Statistics: what each of the tenant's domains sent.
 *
 * The figures the operator reads on Monitoring → Mail, for this tenant's
 * domains: mail sent in the last 24 hours and 7 days, the recipients it went
 * to, and how much of it the sending limits held back or refused. The domain
 * picked at the top of the page is shown first as figures, and every domain
 * below in a table, so one is read without losing sight of the others.
 *
 * A domain that sent nothing is listed with zeros — absent, it would read as
 * "not counted" rather than "quiet".
 */
import { Loader2, AlertCircle, Send } from 'lucide-react';
import clsx from 'clsx';
import type { MailDomainStatsResponse } from '@insula/api-contracts';
import { useMailDomainStats } from '@/hooks/use-email';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

type DomainStats = MailDomainStatsResponse['domains'][number];

interface StatisticsTabProps {
  readonly tenantId: string;
  /** The domain picked in the page's domain selector. */
  readonly selectedDomain: string;
}

const ZERO: Omit<DomainStats, 'domain' | 'emailHosted'> = { sent24h: 0, sent7d: 0, recipients7d: 0, rateLimited7d: 0, quotaRejected7d: 0 };

export default function StatisticsTab({ tenantId, selectedDomain }: StatisticsTabProps) {
  const { data, isLoading, isError, error } = useMailDomainStats(tenantId);
  const stats = data?.data;

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-brand-500" /></div>;
  }
  if (isError || !stats) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        <AlertCircle size={14} className="mr-1.5 inline" />
        Could not load mail statistics{error instanceof Error ? `: ${error.message}` : ''}.
      </div>
    );
  }

  const selected = stats.domains.find((d) => d.domain.toLowerCase() === selectedDomain.toLowerCase())
    ?? { domain: selectedDomain, emailHosted: true, ...ZERO };

  return (
    <div className="space-y-5" data-testid="email-statistics">
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Send size={15} className="text-gray-500 dark:text-gray-400" />
          Mail sent from <span className="font-mono">{selected.domain}</span>
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="email-statistics-selected">
          <Figure label="Sent (24h)" value={selected.sent24h} />
          <Figure label={`Sent (${stats.windowDays}d)`} value={selected.sent7d} />
          <Figure label={`Recipients (${stats.windowDays}d)`} value={selected.recipients7d} />
          <Figure label={`Deferred (${stats.windowDays}d)`} value={selected.rateLimited7d} tone={selected.rateLimited7d > 0 ? 'amber' : undefined}
            hint="Held back by the sending rate limit and delivered later." />
          <Figure label={`Rejected (${stats.windowDays}d)`} value={selected.quotaRejected7d} tone={selected.quotaRejected7d > 0 ? 'red' : undefined}
            hint="Refused because the sending quota was used up — not delivered." />
        </div>
      </section>

      <DomainsTable domains={stats.domains} windowDays={stats.windowDays} selectedDomain={selected.domain} />
    </div>
  );
}

function Figure({ label, value, tone, hint }: {
  readonly label: string;
  readonly value: number;
  readonly tone?: 'amber' | 'red';
  readonly hint?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40" title={hint}>
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={clsx(
        'mt-1 text-xl font-semibold tabular-nums',
        tone === 'red' ? 'text-red-600 dark:text-red-400'
          : tone === 'amber' ? 'text-amber-600 dark:text-amber-400'
            : 'text-gray-900 dark:text-gray-100',
      )}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function DomainsTable({ domains, windowDays, selectedDomain }: {
  readonly domains: readonly DomainStats[];
  readonly windowDays: number;
  readonly selectedDomain: string;
}) {
  const { sortedData, sortKey, sortDirection, onSort } = useSortable(domains, 'sent7d', 'desc');
  const header = (label: string, key: string, title?: string) => (
    <SortableHeader label={label} sortKey={key} currentKey={sortKey} direction={sortDirection} onSort={onSort}
      className="text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400" title={title} />
  );
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <h3 className="px-5 pt-4 text-sm font-semibold text-gray-900 dark:text-gray-100">All your domains</h3>
      <div className="overflow-x-auto">
        <table className="w-full" data-testid="email-statistics-table">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700">
              {header('Domain', 'domain')}
              {header('24h', 'sent24h', 'Messages sent in the last 24 hours')}
              {header(`${windowDays}d`, 'sent7d', `Messages sent in the last ${windowDays} days`)}
              {header('Recipients', 'recipients7d', `Recipients in the last ${windowDays} days`)}
              {header('Deferred', 'rateLimited7d', 'Held back by the sending rate limit and delivered later')}
              {header('Rejected', 'quotaRejected7d', 'Refused because the sending quota was used up')}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {sortedData.map((d) => {
              const isSelected = d.domain.toLowerCase() === selectedDomain.toLowerCase();
              return (
                <tr key={d.domain} className={isSelected ? 'bg-brand-50 dark:bg-brand-900/20' : ''} data-testid={`email-statistics-row-${d.domain}`}>
                  <td className="px-5 py-2.5 text-sm">
                    <span className="font-mono text-gray-900 dark:text-gray-100">{d.domain}</span>
                    {!d.emailHosted && (
                      <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                        title="Sends through the platform's mail relay, but hosts no mailboxes here">
                        sending only
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-sm tabular-nums text-gray-700 dark:text-gray-300">{d.sent24h.toLocaleString()}</td>
                  <td className="px-5 py-2.5 text-sm tabular-nums text-gray-700 dark:text-gray-300">{d.sent7d.toLocaleString()}</td>
                  <td className="px-5 py-2.5 text-sm tabular-nums text-gray-700 dark:text-gray-300">{d.recipients7d.toLocaleString()}</td>
                  <td className={clsx('px-5 py-2.5 text-sm tabular-nums', d.rateLimited7d > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-700 dark:text-gray-300')}>
                    {d.rateLimited7d.toLocaleString()}
                  </td>
                  <td className={clsx('px-5 py-2.5 text-sm tabular-nums', d.quotaRejected7d > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-300')}>
                    {d.quotaRejected7d.toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
