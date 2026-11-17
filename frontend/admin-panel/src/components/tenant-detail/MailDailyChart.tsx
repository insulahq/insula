/**
 * Mail per UTC day over the last two weeks, for one sending domain or all of
 * them, against the daily limit in force now.
 *
 * The limit is per mail domain, so the limit line is drawn only for a single
 * domain — the busiest one by default. Against the all-domains total it would
 * show "over the limit" on days nothing was held.
 *
 * Each bar is what the domain submitted that day: mail accepted (blue), the
 * part of it a limit held back and delivered later (amber, inside the accepted
 * mail — held mail was accepted), and submissions refused because the queue
 * was full (red, on top — refused mail was never accepted).
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { MailDailyResponse } from '@insula/api-contracts';
import { useTenantMailDaily, useTenantMailDomainStats } from '@/hooks/use-tenant-insights';
import { Card } from './ui';

type Day = MailDailyResponse['days'][number];

const ALL = '';

export default function MailDailyChart({ tenantId }: { readonly tenantId: string }) {
  const { data: statsRes } = useTenantMailDomainStats(tenantId);
  // Busiest first (the stats are sorted by 7-day volume).
  const domains = (statsRes?.data?.domains ?? []).map((d) => d.domain);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const domain = picked === undefined ? (domains[0] ?? null) : (picked === ALL ? null : picked);
  // Wait for the domain list, so the first request is already the right one.
  const { data, isLoading } = useTenantMailDaily(statsRes ? tenantId : undefined, domain);
  const days = data?.data?.days ?? [];
  const limit = domain ? (data?.data?.dailyLimit ?? null) : null;

  return (
    <Card
      title={`Sent per day, last ${days.length || 14} days`}
      actions={(
        <>
          {domains.length > 1 && (
            <select
              value={domain ?? ALL}
              onChange={(e) => setPicked(e.target.value)}
              aria-label="Domain"
              className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              data-testid="mail-daily-domain"
            >
              {domains.map((d) => <option key={d} value={d}>{d}</option>)}
              <option value={ALL}>All domains (no limit line)</option>
            </select>
          )}
          <Legend limit={limit} />
        </>
      )}
      testId="mail-daily-chart"
    >
      {isLoading || !statsRes ? (
        <div className="flex h-[200px] items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : (
        <DailyBars days={days} limit={limit} domain={domain} />
      )}
    </Card>
  );
}

function Legend({ limit }: { readonly limit: number | null }) {
  const swatch = (c: string) => <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-sm ${c}`} />;
  return (
    <span className="flex flex-wrap gap-4 text-xs text-gray-600 dark:text-gray-400">
      <span className="inline-flex items-center gap-1.5">{swatch('bg-brand-500')}Sent</span>
      <span className="inline-flex items-center gap-1.5">{swatch('bg-amber-500')}Held back, sent later</span>
      <span className="inline-flex items-center gap-1.5">{swatch('bg-red-500')}Refused</span>
      {limit != null && (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="w-3.5 border-t-2 border-dashed border-gray-500 dark:border-gray-400" />
          Daily limit {limit}
        </span>
      )}
    </span>
  );
}

/** Held mail is part of the accepted count; a hold counted twice (two attempts) never makes it exceed it. */
const heldOf = (d: Day) => Math.min(d.rateLimited, d.sent);

function DailyBars({ days, limit, domain }: { readonly days: readonly Day[]; readonly limit: number | null; readonly domain: string | null }) {
  const peak = Math.max(1, ...days.map((d) => d.sent + d.quotaRejected));
  // The limit line is drawn only when it is near enough to the bars to read
  // against them; far above, it would flatten every bar to the floor.
  const limitOnChart = limit != null && limit > 0 && limit <= peak * 3;
  const top = Math.ceil((limitOnChart ? Math.max(peak, limit) : peak) * 1.15);
  const pct = (n: number) => `${(n / top) * 100}%`;
  const total = days.reduce((n, d) => n + d.sent, 0);
  const held = days.reduce((n, d) => n + heldOf(d), 0);
  const refused = days.reduce((n, d) => n + d.quotaRejected, 0);

  return (
    <>
      <div
        role="img"
        aria-label={`${domain ?? 'All domains'}: ${total} messages sent, ${held} of them held back, and ${refused} refused over the last ${days.length} days${limit != null ? `, daily limit ${limit}` : ''}`}
        className="relative flex h-[200px] items-end gap-2 border-b border-gray-200 pl-9 dark:border-gray-700"
      >
        <div aria-hidden="true" className="absolute bottom-0 left-0 top-0 flex flex-col justify-between text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
          <span>{top}</span><span>{Math.round(top / 2)}</span><span>0</span>
        </div>
        {limitOnChart && (
          <div aria-hidden="true" className="absolute left-9 right-0 border-t-2 border-dashed border-gray-500 opacity-60 dark:border-gray-400" style={{ bottom: pct(limit) }} />
        )}
        {days.map((d) => {
          const h = heldOf(d);
          const parts = [
            d.quotaRejected > 0 && <div key="r" className="bg-red-500" style={{ height: pct(d.quotaRejected) }} />,
            h > 0 && <div key="h" className="bg-amber-500" style={{ height: pct(h) }} />,
            <div key="s" className="bg-brand-500 dark:bg-brand-400" style={{ height: pct(d.sent - h) }} />,
          ].filter(Boolean);
          return (
            <div
              key={d.date}
              className="flex h-full min-w-0 flex-1 flex-col justify-end [&>div:first-child]:rounded-t-sm"
              title={`${d.date}: ${d.sent} sent${h ? ` (${h} held back, sent later)` : ''}${d.quotaRejected ? `, ${d.quotaRejected} refused` : ''}, ${d.recipients} recipients`}
              data-testid={`mail-day-${d.date}`}
            >
              {parts}
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
  );
}
