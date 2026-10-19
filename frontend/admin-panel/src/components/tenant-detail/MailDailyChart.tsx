/**
 * Sent and held-back mail per UTC day over the last two weeks, against the
 * daily limit in force now. "Held back" is what the limits deferred or the
 * queue cap refused — the part of a day's mail the limit actually touched.
 */
import { Loader2 } from 'lucide-react';
import { useTenantMailDaily, useTenantMailUsage } from '@/hooks/use-tenant-insights';
import { Card } from './ui';

export default function MailDailyChart({ tenantId }: { readonly tenantId: string }) {
  const { data, isLoading } = useTenantMailDaily(tenantId);
  const { data: usageRes } = useTenantMailUsage(tenantId);
  const days = data?.data?.days ?? [];
  const limit = usageRes?.data?.day?.limit ?? null;

  const peak = Math.max(1, ...days.map((d) => d.sent + d.rateLimited + d.quotaRejected));
  // The limit line is drawn only when it is near enough to the bars to read
  // against them; far above, it would flatten every bar to the floor.
  const limitOnChart = limit != null && limit > 0 && limit <= peak * 3;
  const top = Math.ceil((limitOnChart ? Math.max(peak, limit!) : peak) * 1.15);
  const pct = (n: number) => `${(n / top) * 100}%`;
  const total = days.reduce((n, d) => n + d.sent, 0);
  const held = days.reduce((n, d) => n + d.rateLimited + d.quotaRejected, 0);

  return (
    <Card
      title={`Sent per day, last ${days.length || 14} days`}
      actions={(
        <span className="flex flex-wrap gap-4 text-xs text-gray-600 dark:text-gray-400">
          <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-brand-500" />Sent</span>
          <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-amber-500" />Held back</span>
          {limit != null && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="w-3.5 border-t-2 border-dashed border-gray-500" />
              Daily limit {limit}{!limitOnChart && limit > 0 ? ' (above the chart)' : ''}
            </span>
          )}
        </span>
      )}
      testId="mail-daily-chart"
    >
      {isLoading ? (
        <div className="flex h-[200px] items-center justify-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : (
        <>
          <div
            role="img"
            aria-label={`${total} messages sent and ${held} held back over the last ${days.length} days${limit != null ? `, daily limit ${limit}` : ''}`}
            className="relative flex h-[200px] items-end gap-2 border-b border-gray-200 pl-9 dark:border-gray-700"
          >
            <div aria-hidden="true" className="absolute bottom-0 left-0 top-0 flex flex-col justify-between text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
              <span>{top}</span><span>{Math.round(top / 2)}</span><span>0</span>
            </div>
            {limitOnChart && (
              <div aria-hidden="true" className="absolute left-9 right-0 border-t-2 border-dashed border-gray-500 opacity-60" style={{ bottom: pct(limit!) }} />
            )}
            {days.map((d) => {
              const heldBack = d.rateLimited + d.quotaRejected;
              return (
                <div
                  key={d.date}
                  className="flex h-full min-w-0 flex-1 flex-col justify-end"
                  title={`${d.date}: ${d.sent} sent, ${d.recipients} recipients${heldBack ? `, ${heldBack} held back` : ''}`}
                  data-testid={`mail-day-${d.date}`}
                >
                  {heldBack > 0 && <div className="rounded-t-sm bg-amber-500" style={{ height: pct(heldBack) }} />}
                  <div className={`bg-brand-500 dark:bg-brand-400 ${heldBack > 0 ? '' : 'rounded-t-sm'}`} style={{ height: pct(d.sent) }} />
                </div>
              );
            })}
          </div>
          <div aria-hidden="true" className="mt-2 flex gap-2 pl-9">
            {days.map((d, i) => (
              <span key={d.date} className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-center text-[11px] text-gray-500 dark:text-gray-400">
                {i === days.length - 1 ? 'Today' : (i % 2 === 0 ? new Date(`${d.date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '')}
              </span>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
