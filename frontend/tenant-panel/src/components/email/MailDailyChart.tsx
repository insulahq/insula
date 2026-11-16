/**
 * One sending domain's mail per UTC day over the last two weeks, against its
 * daily limit — the chart the operator reads on the tenant's Email tab, for
 * the domain picked at the top of Email.
 *
 * Each bar is what the domain submitted that day: mail accepted (blue), the
 * part of it a limit held back and delivered later (amber — held mail was
 * accepted, so it sits inside the accepted count), and messages refused because
 * the queue was full (red, on top — refused mail was never accepted).
 */
import { Loader2, BarChart3 } from 'lucide-react';
import type { MailDailyResponse } from '@insula/api-contracts';
import { useMailDaily } from '@/hooks/use-email';

type Day = MailDailyResponse['days'][number];

/** A hold counted at two delivery attempts never makes it exceed the accepted count. */
const heldOf = (d: Day) => Math.min(d.rateLimited, d.sent);

export default function MailDailyChart({ tenantId, domain }: { readonly tenantId: string; readonly domain: string }) {
  const { data, isLoading, isError } = useMailDaily(tenantId, domain);
  const days = data?.data?.days ?? [];
  const limit = data?.data?.dailyLimit ?? null;

  const peak = Math.max(1, ...days.map((d) => d.sent + d.quotaRejected));
  // Drawn only when near enough to the bars to read against them; far above,
  // it would flatten every bar to the floor.
  const limitOnChart = limit != null && limit > 0 && limit <= peak * 3;
  const top = Math.ceil((limitOnChart ? Math.max(peak, limit) : peak) * 1.15);
  const pct = (n: number) => `${(n / top) * 100}%`;
  const total = days.reduce((n, d) => n + d.sent, 0);
  const held = days.reduce((n, d) => n + heldOf(d), 0);
  const refused = days.reduce((n, d) => n + d.quotaRejected, 0);
  const swatch = (c: string) => <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-sm ${c}`} />;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800" data-testid="email-statistics-daily">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <BarChart3 size={15} className="text-gray-500 dark:text-gray-400" />
          Sent per day, last {days.length || 14} days
        </h3>
        <span className="flex flex-wrap gap-4 text-xs text-gray-600 dark:text-gray-400">
          <span className="inline-flex items-center gap-1.5">{swatch('bg-brand-500')}Sent</span>
          <span className="inline-flex items-center gap-1.5">{swatch('bg-amber-500')}Held back, sent later</span>
          <span className="inline-flex items-center gap-1.5">{swatch('bg-red-500')}Refused</span>
          {limit != null && limit > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="w-3.5 border-t-2 border-dashed border-gray-500 dark:border-gray-400" />
              Daily limit {limit}{limitOnChart ? '' : ' (above the chart)'}
            </span>
          )}
        </span>
      </div>
      {isLoading ? (
        <div className="flex h-[200px] items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : isError ? (
        <p className="text-sm text-red-600 dark:text-red-400">Could not load the daily figures.</p>
      ) : (
        <>
          <div
            role="img"
            aria-label={`${domain}: ${total} messages sent, ${held} of them held back, and ${refused} refused over the last ${days.length} days${limit ? `, daily limit ${limit}` : ''}`}
            className="relative flex h-[200px] items-end gap-1.5 border-b border-gray-200 pl-9 sm:gap-2 dark:border-gray-700"
          >
            <div aria-hidden="true" className="absolute bottom-0 left-0 top-0 flex flex-col justify-between text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
              <span>{top}</span><span>{Math.round(top / 2)}</span><span>0</span>
            </div>
            {limitOnChart && (
              <div aria-hidden="true" className="absolute left-9 right-0 border-t-2 border-dashed border-gray-500 opacity-60 dark:border-gray-400" style={{ bottom: pct(limit) }} />
            )}
            {days.map((d) => {
              const h = heldOf(d);
              return (
                <div
                  key={d.date}
                  className="flex h-full min-w-0 flex-1 flex-col justify-end [&>div:first-child]:rounded-t-sm"
                  title={`${d.date}: ${d.sent} sent${h ? ` (${h} held back, sent later)` : ''}${d.quotaRejected ? `, ${d.quotaRejected} refused` : ''}, ${d.recipients} recipients`}
                  data-testid={`email-statistics-day-${d.date}`}
                >
                  {d.quotaRejected > 0 && <div className="bg-red-500" style={{ height: pct(d.quotaRejected) }} />}
                  {h > 0 && <div className="bg-amber-500" style={{ height: pct(h) }} />}
                  <div className="bg-brand-500 dark:bg-brand-400" style={{ height: pct(d.sent - h) }} />
                </div>
              );
            })}
          </div>
          <div aria-hidden="true" className="mt-2 flex gap-1.5 pl-9 sm:gap-2">
            {days.map((d, i) => (
              <span key={d.date} className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-center text-[11px] text-gray-500 dark:text-gray-400">
                {i === days.length - 1 ? 'Today' : (i % 2 === 0 ? new Date(`${d.date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '')}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
