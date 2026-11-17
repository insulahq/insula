/**
 * Email → Statistics: what each of the tenant's domains sent.
 *
 * The figures the operator reads on Monitoring → Mail, for this tenant's
 * domains: mail sent in the last 24 hours and 7 days, the recipients it went
 * to, and how much of it the sending limits held back or refused. The domain
 * picked at the top of the page is shown first — today against its limits,
 * what a limit is holding back right now, and its last 14 days — and every
 * domain below in a table, so one is read without losing sight of the others.
 * The dashboard's sending-limit card and the limit notifications link here
 * with the domain picked.
 *
 * A domain that sent nothing is listed with zeros — absent, it would read as
 * "not counted" rather than "quiet".
 */
import { Loader2, AlertCircle, AlertTriangle, Send } from 'lucide-react';
import clsx from 'clsx';
import type { MailDomainStatsResponse } from '@insula/api-contracts';
import { useMailDomainStats } from '@/hooks/use-email';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import MailDailyChart from './MailDailyChart';
import { COUNTING_EXPLAINED, HOLDING_EXPLAINED, REFUSAL_EXPLAINED, throttleText, windowText } from './mail-throttle';

type DomainStats = MailDomainStatsResponse['domains'][number];

interface StatisticsTabProps {
  readonly tenantId: string;
  /** The domain picked in the page's domain selector. */
  readonly selectedDomain: string;
}

const ZERO: Omit<DomainStats, 'domain' | 'emailHosted'> = {
  sent24h: 0, sent7d: 0, recipients7d: 0, rateLimited7d: 0, quotaRejected7d: 0, sentThisHour: 0, sentToday: 0, throttle: null,
};

const HELD_HINT = 'Over a sending limit: accepted, held in the queue and delivered when the limit resets.';
const REFUSED_HINT = 'Refused with a temporary error because the domain already had its daily limit of messages waiting. The sending program keeps them and tries again.';

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

  // Spread over ZERO: during a rollout the panel can be ahead of the API.
  const found = stats.domains.find((d) => d.domain.toLowerCase() === selectedDomain.toLowerCase());
  const selected: DomainStats = { ...ZERO, ...(found ?? { domain: selectedDomain, emailHosted: true }) };

  return (
    <div className="space-y-5" data-testid="email-statistics">
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Send size={15} className="text-gray-500 dark:text-gray-400" />
          Mail sent from <span className="font-mono">{selected.domain}</span>
        </h3>
        {selected.throttle && (
          <div className="mb-4 rounded-lg border border-l-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" data-testid="email-statistics-throttle">
            <p className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle size={14} />
              {windowText(selected.throttle)} for {selected.domain}
            </p>
            <p className="mt-1">{throttleText(selected.throttle)}.</p>
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">{HOLDING_EXPLAINED} {REFUSAL_EXPLAINED}</p>
          </div>
        )}
        {stats.outboundSuspended && (
          <div className="mb-4 rounded-lg border border-l-4 border-red-500 bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200" data-testid="email-statistics-suspended">
            Sending is suspended for your account: every new message is refused. Receiving mail and webmail keep working. Contact support to resume sending.
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="email-statistics-today">
          <Figure label="Sent this hour" value={selected.sentThisHour} of={stats.hourlyLimit}
            tone={stats.hourlyLimit > 0 && selected.sentThisHour >= stats.hourlyLimit ? 'amber' : undefined}
            hint="Since the full hour, UTC. The hourly limit resets at the next full hour." />
          <Figure label="Sent today" value={selected.sentToday} of={stats.dailyLimit}
            tone={stats.dailyLimit > 0 && selected.sentToday >= stats.dailyLimit ? 'amber' : undefined}
            hint="Since 00:00 UTC. The daily limit resets at 00:00 UTC." />
          <Figure label="Held back now" value={selected.throttle?.heldNow ?? 0} tone={(selected.throttle?.heldNow ?? 0) > 0 ? 'amber' : undefined} hint={HELD_HINT} />
          <Figure label="Refused today" value={selected.throttle?.refusedToday ?? 0} tone={(selected.throttle?.refusedToday ?? 0) > 0 ? 'red' : undefined} hint={REFUSED_HINT} />
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{COUNTING_EXPLAINED}</p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="email-statistics-selected">
          <Figure label="Sent (24h)" value={selected.sent24h} />
          <Figure label={`Sent (${stats.windowDays}d)`} value={selected.sent7d} />
          <Figure label={`Recipients (${stats.windowDays}d)`} value={selected.recipients7d} />
          <Figure label={`Held back (${stats.windowDays}d)`} value={selected.rateLimited7d} tone={selected.rateLimited7d > 0 ? 'amber' : undefined}
            hint={HELD_HINT} />
          <Figure label={`Refused (${stats.windowDays}d)`} value={selected.quotaRejected7d} tone={selected.quotaRejected7d > 0 ? 'red' : undefined}
            hint={REFUSED_HINT} />
        </div>
      </section>

      <MailDailyChart tenantId={tenantId} domain={selected.domain} />

      <DomainsTable domains={stats.domains} windowDays={stats.windowDays} selectedDomain={selected.domain} />
    </div>
  );
}

function Figure({ label, value, of, tone, hint }: {
  readonly label: string;
  readonly value: number;
  /** The limit the value is held to, shown as "of N". */
  readonly of?: number;
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
        {of != null && of > 0 && <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">of {of.toLocaleString()}</span>}
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
              {header('Today', 'sentToday', 'Messages sent since 00:00 UTC — the day the daily limit counts')}
              {header('Held back', 'rateLimited7d', HELD_HINT)}
              {header('Refused', 'quotaRejected7d', REFUSED_HINT)}
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
                  <td className={clsx('px-5 py-2.5 text-sm tabular-nums', d.throttle ? 'font-semibold text-amber-600 dark:text-amber-400' : 'text-gray-700 dark:text-gray-300')}
                    title={d.throttle ? throttleText(d.throttle) : undefined}>
                    {(d.sentToday ?? 0).toLocaleString()}
                  </td>
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
