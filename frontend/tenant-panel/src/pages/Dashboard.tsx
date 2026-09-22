/**
 * Hosting overview.
 *
 * The customer's half of the same design as the operator console, answering a
 * different question. An operator asks "is the platform broken"; a customer
 * asks "are my sites up, and am I about to run out of something I pay for".
 * So: no node names, no cluster internals, and `reserved` framed as what their
 * own apps hold — because that is the number that refuses their next deploy
 * while the usage figure says there is plenty of room.
 *
 * Warnings are conditional. Nothing renders in the attention band when nothing
 * needs the customer, and every chip corresponds to a notification category
 * that can actually fire.
 */
import { Link } from 'react-router-dom';
import type { TenantSite } from '@insula/api-contracts';
import { useTenantContext } from '@/hooks/use-tenant-context';
import { useOverviewSummary, useOverviewLive } from '@/hooks/use-hosting-overview';
import {
  AlertBand, HoverCard, MatrixTile, SectionFallback, Tile, TileSkeleton, TriadBar,
  type MatrixCell,
} from '@/components/console/ConsoleTiles';

function SectionHead({ title, count }: { title: string; count?: string }) {
  return (
    <div className="mt-6 mb-2.5 flex items-center gap-2.5">
      <h2 className="whitespace-nowrap text-[11px] font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400">{title}</h2>
      {count ? <span className="font-mono text-[11px] text-gray-400 dark:text-gray-500">{count}</span> : null}
      <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
    </div>
  );
}

const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return 'never';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs}h` : `${Math.round(hrs / 24)}d`;
};

export default function Dashboard() {
  const { tenantId } = useTenantContext();
  const summary = useOverviewSummary(tenantId ?? undefined);
  const live = useOverviewLive(tenantId ?? undefined);

  const s = summary.data?.data;
  const l = live.data?.data;
  const alerts = s?.alerts.data ?? [];
  const loadingFirst = summary.isLoading && !s;

  return (
    <div className="mx-auto max-w-[1340px] px-1 pb-16">
      <header className="mb-3 flex flex-wrap items-baseline gap-3 border-b border-gray-200 pb-3 dark:border-gray-700">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Hosting Overview</h1>
        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
          {s?.plan.data ? `${s.plan.data.name} plan` : 'loading…'}
        </span>
      </header>

      {/* ── needs your attention: absent when there is nothing ─────── */}
      {loadingFirst ? (
        <>
          <SectionHead title="Needs your attention" />
          <p className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-3 text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400">
            Checking your sites, mail and restore points…
          </p>
        </>
      ) : alerts.length > 0 ? (
        <>
          <SectionHead title="Needs your attention" count={String(alerts.length)} />
          <AlertBand alerts={alerts} />
        </>
      ) : (
        <>
          <SectionHead title="Needs your attention" />
          <p className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-3 text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400">
            Nothing needs you right now.
          </p>
        </>
      )}

      {/* ── your plan ──────────────────────────────────────────────── */}
      <SectionHead title="Your plan" count="in use · reserved by your apps · free" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {live.isLoading && !l ? (
          <><TileSkeleton /><TileSkeleton /><TileSkeleton /><TileSkeleton /></>
        ) : (
          <>
            {l?.resources.data ? (
              <>
                <TriadBar triad={l.resources.data.cpu} label="CPU" to="/resource-usage" vocab="reserved" />
                <TriadBar triad={l.resources.data.memory} label="Memory" to="/resource-usage" vocab="reserved" />
                <TriadBar triad={l.resources.data.storage} label="Storage" to="/resource-usage" vocab="reserved" />
              </>
            ) : (
              <SectionFallback title="Your plan" to="/resource-usage" section={l?.resources ?? { state: 'stale', reason: null, observedAt: null }} />
            )}
            <BandwidthTile summary={s} />
          </>
        )}
      </div>

      {/* ── sites ──────────────────────────────────────────────────── */}
      <SectionHead
        title="Sites & applications"
        count={l?.sites.data ? `${l.sites.data.length} site${l.sites.data.length === 1 ? '' : 's'}` : undefined}
      />
      <SiteStrip sites={l?.sites.data ?? []} loading={live.isLoading && !l} />

      {/* ── services ───────────────────────────────────────────────── */}
      <SectionHead title="Services" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {loadingFirst ? (
          <><TileSkeleton /><TileSkeleton /><TileSkeleton /><TileSkeleton /></>
        ) : (
          <>
            <MailTile summary={s} />
            <DomainsTile summary={s} />
            <BackupsTile summary={s} />
            <TasksTile summary={s} />
          </>
        )}
      </div>

      {/* ── activity ───────────────────────────────────────────────── */}
      <SectionHead title="Recent activity" />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <BlockedTile live={l} />
        <ChangesTile summary={s} />
      </div>
    </div>
  );
}

type Summary = NonNullable<ReturnType<typeof useOverviewSummary>['data']>['data'];
type Live = NonNullable<ReturnType<typeof useOverviewLive>['data']>['data'];

/* ── bandwidth ───────────────────────────────────────────────────── */

function BandwidthTile({ summary }: { summary: Summary | undefined }) {
  const p = summary?.plan.data;
  if (!p) return <SectionFallback title="Bandwidth" to="/resource-usage" section={summary?.plan ?? { state: 'stale', reason: null, observedAt: null }} />;
  const pct = p.bandwidthLimitGb > 0 ? (p.bandwidthUsedGb / p.bandwidthLimitGb) * 100 : 0;
  const tone = pct >= 100 ? 'crit' : pct >= 80 ? 'warn' : 'ok';
  return (
    <Tile title="Bandwidth" to="/resource-usage" card={(
      <HoverCard title="Bandwidth this cycle" rows={[
        ['Allowance', `${p.bandwidthLimitGb} GB`],
        ['Used', `${p.bandwidthUsedGb.toFixed(2)} GB · ${Math.round(pct)}%`],
        ['Remaining', `${Math.max(0, p.bandwidthLimitGb - p.bandwidthUsedGb).toFixed(2)} GB`],
        ['Cycle resets in', p.bandwidthResetDays == null ? 'unknown' : `${p.bandwidthResetDays} days`],
        ['Capped', p.bandwidthCapped ? 'yes' : 'no'],
      ]} note="Counted on traffic leaving your sites. Restores and backups are not counted." />
    )}>
      <div className="mb-2 flex flex-wrap items-baseline gap-1.5">
        <span className="font-mono text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {p.bandwidthUsedGb.toFixed(1)}
        </span>
        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">GB this cycle</span>
        <span className="ml-auto whitespace-nowrap font-mono text-xs text-gray-500 dark:text-gray-400">of {p.bandwidthLimitGb}</span>
      </div>
      <div className="h-3 overflow-hidden rounded-md bg-gray-200 dark:bg-gray-700">
        <div
          className={tone === 'crit' ? 'h-full bg-red-500' : tone === 'warn' ? 'h-full bg-amber-500' : 'h-full bg-teal-600 dark:bg-teal-400'}
          style={{ width: `${Math.min(100, pct).toFixed(1)}%` }}
        />
      </div>
      <div className="mt-2 font-mono text-[11px] tabular-nums text-gray-600 dark:text-gray-400">
        used {Math.round(pct)}% · left {Math.max(0, p.bandwidthLimitGb - p.bandwidthUsedGb).toFixed(1)} GB
      </div>
      <p className="mt-2.5 border-t border-dashed border-gray-200 pt-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400">
        {p.bandwidthCapped
          ? 'Your allowance is used up — traffic may be slowed until the cycle resets.'
          : p.bandwidthResetDays == null
            ? 'Resets at the start of your next billing cycle.'
            : `Resets in ${p.bandwidthResetDays} days.`}
      </p>
    </Tile>
  );
}

/* ── site strip ──────────────────────────────────────────────────── */

function SiteStrip({ sites, loading }: { sites: readonly TenantSite[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        {[0, 1, 2].map((i) => <div key={i} className="mb-3 h-6 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />)}
      </div>
    );
  }
  if (sites.length === 0) {
    return (
      <p className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
        No sites yet. Deploy one from Applications.
      </p>
    );
  }
  return (
    // NOT overflow-hidden: that clips the last row's hover card.
    <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_88px_96px_92px] items-center gap-3 rounded-t-xl bg-gray-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 lg:grid dark:bg-gray-900/40 dark:text-gray-400">
        <span>Site</span><span>Application</span>
        <span className="text-right">Blocked</span>
        <span className="text-right">Certificate</span>
        <span className="text-right">State</span>
      </div>
      {sites.map((site, i) => {
        const sev = site.status === 'running' ? 'ok' : site.status === 'failed' ? 'crit' : 'warn';
        return (
          <Link
            key={site.host}
            to="/applications"
            className={`group relative grid grid-cols-1 items-center gap-y-2 gap-x-3 border-t border-gray-200 px-4 py-3 transition-colors hover:bg-gray-50 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_88px_96px_92px] dark:border-gray-700 dark:hover:bg-gray-700/40 ${
              i === sites.length - 1 ? 'rounded-b-xl' : ''
            }`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${
                sev === 'crit' ? 'bg-red-500' : sev === 'warn' ? 'bg-amber-500' : 'bg-green-500'
              }`} />
              <b title={site.host} className="min-w-0 truncate font-mono text-[13px] font-semibold text-gray-900 dark:text-gray-100">{site.host}</b>
            </span>
            <span className="min-w-0">
              <span className="inline-flex max-w-full items-center truncate rounded-md border border-gray-300 px-1.5 py-0.5 font-mono text-[10px] text-gray-600 dark:border-gray-600 dark:text-gray-400">
                {site.application}
              </span>
            </span>
            <span className="font-mono text-xs tabular-nums text-gray-600 lg:text-right dark:text-gray-400">
              {site.blocked7d.toLocaleString()}
            </span>
            <span className="lg:text-right">
              <span className={`inline-flex min-w-[58px] items-center justify-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${
                site.tlsState === 'valid' ? 'border-green-500 text-green-600 dark:text-green-400'
                  : site.tlsState === 'expired' ? 'border-red-500 text-red-600 dark:text-red-400'
                    : 'border-amber-500 text-amber-600 dark:text-amber-400'
              }`}>
                {site.tlsState === 'valid' && site.tlsDaysRemaining != null ? `${site.tlsDaysRemaining}d` : site.tlsState}
              </span>
            </span>
            <span className="lg:text-right">
              <span className={`inline-flex min-w-[74px] items-center justify-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${
                sev === 'ok' ? 'border-green-500 text-green-600 dark:text-green-400'
                  : sev === 'crit' ? 'border-red-500 text-red-600 dark:text-red-400'
                    : 'border-amber-500 text-amber-600 dark:text-amber-400'
              }`}>
                {site.status}
              </span>
            </span>
            <HoverCard
              title={site.host}
              rows={[
                ['Application', site.application],
                ['State', site.status],
                ['Attacks blocked · 7 days', site.blocked7d.toLocaleString()],
                ['Scheduled tasks', String(site.cronJobs)],
                ['Certificate', site.tlsState === 'valid' && site.tlsDaysRemaining != null
                  ? `valid, renews in ${site.tlsDaysRemaining} days` : site.tlsState],
              ]}
              note={sev === 'ok'
                ? 'Serving normally. Open Applications to deploy, restart or view logs.'
                : 'Not serving visitors right now. Open Applications to start it or read the logs.'}
            />
          </Link>
        );
      })}
    </div>
  );
}

/* ── service tiles ───────────────────────────────────────────────── */

function MailTile({ summary }: { summary: Summary | undefined }) {
  const m = summary?.mail.data;
  if (!m) return <SectionFallback title="Mail" to="/email" section={summary?.mail ?? { state: 'stale', reason: null, observedAt: null }} />;
  const cells: MatrixCell[] = [
    { k: 'Mailboxes', v: String(m.mailboxes), sub: m.maxMailboxes > 0 ? `of ${m.maxMailboxes}` : undefined },
    { k: 'Storage used', v: `${m.storageUsedGb.toFixed(1)}`, sub: `of ${m.storageLimitGb.toFixed(0)} GB` },
    { k: 'Sent today', v: String(m.sentToday), sub: m.dailyLimit > 0 ? `of ${m.dailyLimit}` : undefined },
    {
      k: 'Fullest mailbox',
      v: m.fullestMailboxPct == null ? '—' : `${m.fullestMailboxPct}%`,
      tone: m.fullestMailboxPct == null ? undefined
        : m.fullestMailboxPct >= 100 ? 'crit' : m.fullestMailboxPct >= 90 ? 'warn' : 'ok',
    },
  ];
  return (
    <MatrixTile title="Mail" to="/email" cells={cells} card={(
      <HoverCard title="Mail" rows={[
        ['Mailboxes', m.maxMailboxes > 0 ? `${m.mailboxes} of ${m.maxMailboxes}` : String(m.mailboxes)],
        ['Storage used', `${m.storageUsedGb.toFixed(1)} of ${m.storageLimitGb.toFixed(0)} GB`],
        ['Fullest mailbox', m.fullestMailboxAddress
          ? `${m.fullestMailboxAddress} · ${m.fullestMailboxPct}%` : '—'],
        ['Sent today', m.dailyLimit > 0 ? `${m.sentToday} of ${m.dailyLimit}` : String(m.sentToday)],
      ]} note="A mailbox at 100% of its own quota refuses new mail — the count against your plan does not." />
    )} />
  );
}

function DomainsTile({ summary }: { summary: Summary | undefined }) {
  const d = summary?.domains.data;
  if (!d) return <SectionFallback title="Domains & certificates" to="/domains" section={summary?.domains ?? { state: 'stale', reason: null, observedAt: null }} />;
  return (
    <MatrixTile title="Domains & certificates" to="/domains" cells={[
      { k: 'Domains', v: String(d.domains) },
      { k: 'Verified', v: String(d.verified), sub: `of ${d.domains}`, tone: d.verified === d.domains ? 'ok' : 'warn' },
      { k: 'Certificates', v: String(d.certificates), tone: 'ok' },
      { k: 'Renews in', v: d.nearestRenewalDays == null ? '—' : `${d.nearestRenewalDays}d` },
    ]} card={(
      <HoverCard title="Domains & certificates" rows={[
        ['Domains', String(d.domains)],
        ['Verified', `${d.verified} of ${d.domains}`],
        ['Certificates', String(d.certificates)],
        ['Earliest renewal', d.nearestRenewalDays == null ? '—' : `${d.nearestRenewalDays} days`],
      ]} note="Certificates renew automatically about 30 days before they expire." />
    )} />
  );
}

function BackupsTile({ summary }: { summary: Summary | undefined }) {
  const b = summary?.backups.data;
  if (!b) return <SectionFallback title="Backups & restore" to="/backups" section={summary?.backups ?? { state: 'stale', reason: null, observedAt: null }} />;
  return (
    <MatrixTile title="Backups & restore" to="/backups" cells={[
      { k: 'Restore points', v: String(b.restorePoints), tone: b.restorePoints > 0 ? 'ok' : 'warn' },
      { k: 'Newest', v: ago(b.newestAt), sub: b.newestAt ? 'ago' : undefined },
      { k: 'Oldest', v: ago(b.oldestAt), sub: b.oldestAt ? 'ago' : undefined },
      { k: 'Covers', v: b.coversFiles && b.coversDatabases ? 'Both' : 'Partial', tone: b.coversFiles && b.coversDatabases ? 'ok' : 'warn' },
    ]} card={(
      <HoverCard title="What you can restore to" rows={[
        ['Restore points', String(b.restorePoints)],
        ['Newest', b.newestAt ? `${ago(b.newestAt)} ago` : 'none yet'],
        ['Oldest', b.oldestAt ? `${ago(b.oldestAt)} ago` : 'none yet'],
        ['Covers', 'site files and databases'],
      ]} note="Restoring is self-service from the Backups page — pick a point and choose what to bring back." />
    )} />
  );
}

function TasksTile({ summary }: { summary: Summary | undefined }) {
  const t = summary?.scheduledTasks.data;
  if (!t) return <SectionFallback title="Scheduled tasks" to="/cron-jobs" section={summary?.scheduledTasks ?? { state: 'stale', reason: null, observedAt: null }} />;
  return (
    <MatrixTile title="Scheduled tasks" to="/cron-jobs" cells={[
      { k: 'Jobs', v: String(t.total), sub: `${t.enabled} enabled` },
      { k: 'Failing', v: String(t.failed24h), tone: t.failed24h > 0 ? 'warn' : 'ok' },
      { k: 'Enabled', v: String(t.enabled) },
      { k: 'Disabled', v: String(Math.max(0, t.total - t.enabled)) },
    ]} card={(
      <HoverCard title="Scheduled tasks" rows={[
        ['Jobs', String(t.total)],
        ['Enabled', String(t.enabled)],
        ['Currently failing', String(t.failed24h)],
      ]} note="A job that keeps failing will not retry on its own — open it to see the output." />
    )} />
  );
}

/* ── activity ────────────────────────────────────────────────────── */

function BlockedTile({ live }: { live: Live | undefined }) {
  const rows = live?.blocked.data ?? [];
  return (
    <Tile title="Attacks blocked for you" to="/domains" card={(
      <HoverCard title="Recently blocked" rows={[
        ['Shown', String(rows.length)],
        ['Reached your sites', '0'],
      ]} note="These never reached your applications. No action is needed — this is the protection working." />
    )}>
      <div className="flex flex-1 flex-col gap-px overflow-hidden rounded-lg bg-gray-200 dark:bg-gray-700">
        {rows.length === 0 ? (
          <p className="bg-white p-2.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            Nothing blocked recently.
          </p>
        ) : rows.map((r, i) => (
          <div key={`${r.label}-${i}`} className={`flex min-w-0 items-center gap-2 border-l-2 bg-white px-2.5 py-1.5 dark:bg-gray-800 ${
            r.severity === 'critical' ? 'border-red-500' : 'border-amber-500'
          }`}>
            <span className="min-w-0 flex-1 truncate text-xs text-gray-800 dark:text-gray-200">{r.label}</span>
            <span className="min-w-0 max-w-[40%] shrink truncate font-mono text-[11px] text-gray-500 dark:text-gray-400">{r.host}</span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-gray-500 dark:text-gray-400">{ago(r.at)}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

function ChangesTile({ summary }: { summary: Summary | undefined }) {
  const rows = summary?.recentChanges.data ?? [];
  return (
    <Tile title="Recent changes" to="/notifications">
      <div className="flex flex-1 flex-col gap-px overflow-hidden rounded-lg bg-gray-200 dark:bg-gray-700">
        {rows.length === 0 ? (
          <p className="bg-white p-2.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">Nothing recorded.</p>
        ) : rows.map((r, i) => (
          <div key={`${r.label}-${i}`} className={`flex min-w-0 items-center gap-2 border-l-2 bg-white px-2.5 py-1.5 dark:bg-gray-800 ${
            r.severity === 'critical' ? 'border-red-500' : r.severity === 'warning' ? 'border-amber-500' : 'border-green-500'
          }`}>
            <span className="min-w-0 flex-1 truncate text-xs text-gray-800 dark:text-gray-200">{r.label}</span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-gray-500 dark:text-gray-400">{ago(r.at)}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}
