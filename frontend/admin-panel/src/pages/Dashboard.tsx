/**
 * Operator console.
 *
 * Answers two questions in the order an operator asks them: is anything
 * wrong, and where is my capacity going.
 *
 * Two principles shape the layout:
 *
 *   Warnings are CONDITIONAL. The attention band does not exist when there is
 *   nothing in it — not greyed, not empty, absent. A region that is usually
 *   blank is a region people learn to skip, and that is the one region that
 *   must never be skipped.
 *
 *   Capacity is a triad, not a percentage. Production runs at 12% CPU usage
 *   and 92% CPU commitment: the second number is what refuses the next
 *   deployment while the first says there is plenty of room.
 *
 * Fed by exactly two endpoints — see use-operator-console.ts for why.
 */
import { Link } from 'react-router-dom';
import type { AdminNode, DashboardAlert } from '@insula/api-contracts';
import { useConsoleSummary, useConsoleLive } from '@/hooks/use-operator-console';
import {
  AlertBand, HoverCard, MatrixTile, SectionFallback, Tile, TileSkeleton, TriadBar,
  type MatrixCell,
} from '@/components/console/ConsoleTiles';

function SectionHead({ title, count }: { title: string; count?: string }) {
  return (
    <div className="mt-6 mb-2.5 flex items-center gap-2.5">
      <h2 className="whitespace-nowrap text-[11px] font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400">
        {title}
      </h2>
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

const bytesToGb = (b: number | null): string =>
  b == null ? '—' : `${(b / 1e9).toFixed(1)} GB`;

export default function Dashboard() {
  const summary = useConsoleSummary();
  const live = useConsoleLive();

  const s = summary.data?.data;
  const l = live.data?.data;

  // The band fills in two stages: database alerts arrive on the fast poll,
  // cluster alerts (volumes, orphaned pods) on the slow one.
  const alerts: DashboardAlert[] = [
    ...(s?.alerts.data ?? []),
    ...(l?.clusterAlerts.data ?? []),
  ];

  const loadingFirst = summary.isLoading && !s;

  return (
    <div className="w-full px-1 pb-16">
      <header className="mb-3 flex flex-wrap items-baseline gap-3 border-b border-gray-200 pb-3 dark:border-gray-700">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Operator Console</h1>
        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
          {s ? `updated ${ago(s.generatedAt)} ago` : 'loading…'}
        </span>
      </header>

      {/* ── attention: conditional, and absent when empty ──────────── */}
      {loadingFirst ? (
        <>
          <SectionHead title="Needs attention" />
          <p className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-3 text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400">
            Checking alerts, nodes, backups and mail…
          </p>
        </>
      ) : alerts.length > 0 ? (
        <>
          <SectionHead title="Needs attention" count={`${alerts.length} open`} />
          <AlertBand alerts={alerts} />
        </>
      ) : (
        <>
          <SectionHead title="Needs attention" />
          <p className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-3 text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400">
            Nothing needs attention — no alerts firing and every node ready.
          </p>
        </>
      )}

      {/* ── cluster capacity ───────────────────────────────────────── */}
      <SectionHead title="Cluster capacity" count="in use · committed · schedulable" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {live.isLoading && !l ? (
          <><TileSkeleton /><TileSkeleton /><TileSkeleton /></>
        ) : l?.cluster.data ? (
          <>
            <TriadBar triad={l.cluster.data.cpu} label="CPU" to="/cluster/nodes" />
            <TriadBar triad={l.cluster.data.memory} label="Memory" to="/cluster/nodes" />
            <TriadBar triad={l.cluster.data.storage} label="Storage" to="/cluster/storage" />
          </>
        ) : (
          <SectionFallback title="Cluster capacity" to="/cluster/nodes" section={l?.cluster ?? { state: 'stale', reason: null, observedAt: null }} />
        )}
      </div>

      {l?.cluster.data ? (
        <div className={`mt-3 rounded-xl border p-3 text-sm ${
          l.cluster.data.survivesSingleNodeLoss
            ? 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
            : 'border-amber-500 bg-amber-50 dark:bg-amber-950/40'
        }`}>
          <span className="mr-2 font-mono text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">Failover</span>
          {l.cluster.data.nodeCount <= 1 ? (
            <span className="text-gray-700 dark:text-gray-300">
              <b>No redundancy.</b> A single node carries every workload — losing it is a full outage.
            </span>
          ) : l.cluster.data.survivesSingleNodeLoss ? (
            <span className="text-gray-700 dark:text-gray-300">
              <b>Survives losing any one node.</b> Worst case is {l.cluster.data.worstNode}.
            </span>
          ) : (
            <span className="text-amber-800 dark:text-amber-200">
              <b>Would not survive losing {l.cluster.data.worstNode}.</b> Its requests do not fit on the rest.
            </span>
          )}
        </div>
      ) : null}

      {/* ── nodes ──────────────────────────────────────────────────── */}
      <SectionHead
        title="Nodes"
        count={l?.nodes.data ? `${l.nodes.data.length} node${l.nodes.data.length === 1 ? '' : 's'}` : undefined}
      />
      <NodeStrip nodes={l?.nodes.data ?? []} loading={live.isLoading && !l} />

      {/* ── platform ───────────────────────────────────────────────── */}
      <SectionHead title="Platform" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {loadingFirst ? (
          <><TileSkeleton /><TileSkeleton /><TileSkeleton /><TileSkeleton /></>
        ) : (
          <>
            <MailTile live={l} />
            <WebDefenceTile live={l} />
            <TenantsTile summary={s} />
            <BackupsTile summary={s} />
          </>
        )}
      </div>

      {/* ── operations ─────────────────────────────────────────────── */}
      <SectionHead title="Operations" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {loadingFirst ? (
          <><TileSkeleton /><TileSkeleton /><TileSkeleton /><TileSkeleton /></>
        ) : (
          <>
            <CertificatesTile summary={s} />
            <ScheduledTasksTile summary={s} />
            <UpdatesTile summary={s} />
            <ChangesTile summary={s} />
          </>
        )}
      </div>
    </div>
  );
}

/* ── node strip ──────────────────────────────────────────────────── */

function MiniTriad({ label, inUse, committed, total, unit }: {
  label: string; inUse: number; committed: number; total: number; unit: string;
}) {
  const pct = total > 0 ? (committed / total) * 100 : 0;
  return (
    <div className="min-w-0">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] tabular-nums text-gray-600 dark:text-gray-400">
        <span className="whitespace-nowrap">
          <span className="text-gray-900 dark:text-gray-100">{inUse.toFixed(2)}</span> / {committed.toFixed(2)}
        </span>
        <span className="min-w-0 truncate opacity-60">of {total.toFixed(2)} {unit}</span>
        <span className="ml-auto whitespace-nowrap">{Math.round(pct)}%</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
        <div className={pct >= 90 ? 'bg-amber-500' : 'bg-teal-600 dark:bg-teal-400'}
             style={{ width: `${Math.min(100, (inUse / (total || 1)) * 100).toFixed(1)}%` }} />
        <div className={`opacity-60 ${pct >= 90 ? 'bg-amber-300' : 'bg-teal-300 dark:bg-teal-700'}`}
             style={{ width: `${Math.max(0, Math.min(100, ((committed - inUse) / (total || 1)) * 100)).toFixed(1)}%` }} />
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}


function NodeStrip({ nodes, loading }: { nodes: readonly AdminNode[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        {[0, 1].map((i) => <div key={i} className="mb-3 h-6 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />)}
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <p className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
        No nodes could be read.
      </p>
    );
  }
  return (
    // NOT overflow-hidden: that clips the last row's hover card. Corners are
    // kept by rounding the first and last rows instead.
    <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      {/* NODE COLUMN TEMPLATE — must stay byte-identical to the row template
          below (minus the lg: prefix). The header and each row are separate
          grid containers, so `auto` tracks sized to their own content — the
          word "Role" up here, a bordered badge down there — and the columns
          drifted apart. Fixed widths resolve the same everywhere. Spelled
          out twice on purpose: Tailwind only emits CSS for class names it
          can see literally in the source. dashboard-node-grid.test.ts pins
          the two copies together. */}
      <div className="hidden grid-cols-[minmax(0,1.3fr)_5rem_minmax(0,2.4fr)_minmax(0,2.4fr)_4rem_3.5rem] items-center gap-3 rounded-t-xl bg-gray-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 lg:grid dark:bg-gray-900/40 dark:text-gray-400">
        <span>Node</span><span>Role</span><span>CPU — in use / committed</span>
        <span>Memory — in use / committed</span>
        <span className="text-right">Disk</span><span className="text-right">Pods</span>
      </div>
      {nodes.map((n, i) => {
        const sev = !n.ready ? 'crit' : (n.pressures.length > 0 || n.evictionsLastHour > 0 || (n.diskUsedPct ?? 0) >= 70) ? 'warn' : 'ok';
        return (
          <Link
            key={n.name}
            to="/cluster/nodes"
            className={`group relative grid grid-cols-1 items-center gap-y-2 gap-x-3 border-t border-gray-200 px-4 py-3 transition-colors hover:bg-gray-50 lg:grid-cols-[minmax(0,1.3fr)_5rem_minmax(0,2.4fr)_minmax(0,2.4fr)_4rem_3.5rem] dark:border-gray-700 dark:hover:bg-gray-700/40 ${
              i === nodes.length - 1 ? 'rounded-b-xl' : ''
            }`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${
                sev === 'crit' ? 'bg-red-500' : sev === 'warn' ? 'bg-amber-500' : 'bg-green-500'
              }`} />
              <b title={n.name} className="min-w-0 truncate font-mono text-[13px] font-semibold text-gray-900 dark:text-gray-100">{n.name}</b>
            </span>
            <span className="inline-flex w-fit items-center rounded-md border border-gray-300 px-1.5 py-0.5 font-mono text-[10px] text-gray-600 dark:border-gray-600 dark:text-gray-400">
              {n.role}
            </span>
            <MiniTriad label="CPU" inUse={n.cpu.inUse} committed={n.cpu.committed} total={n.cpu.total} unit="cores" />
            <MiniTriad label="Memory" inUse={n.memory.inUse} committed={n.memory.committed} total={n.memory.total} unit="GiB" />
            <span className="text-right font-mono text-xs tabular-nums text-gray-600 dark:text-gray-400">
              {n.diskUsedPct == null ? '—' : `${Math.round(n.diskUsedPct)}%`}
            </span>
            <span className="text-right font-mono text-xs tabular-nums text-gray-600 dark:text-gray-400">{n.pods}</span>
            <HoverCard
              title={`${n.name} — node detail`}
              rows={[
                ['CPU in use / committed', `${n.cpu.inUse.toFixed(2)} / ${n.cpu.committed.toFixed(2)} of ${n.cpu.total.toFixed(2)}`],
                ['Memory in use / committed', `${n.memory.inUse.toFixed(2)} / ${n.memory.committed.toFixed(2)} of ${n.memory.total.toFixed(2)} GiB`],
                ['Schedulable CPU left', `${Math.max(0, n.cpu.total - n.cpu.committed).toFixed(2)} cores`],
                ['Pods scheduled', String(n.pods)],
                ['Disk used', n.diskUsedPct == null ? '—' : `${Math.round(n.diskUsedPct)}%`],
                ['Evictions, last hour', String(n.evictionsLastHour)],
                ['Pressures', n.pressures.length ? n.pressures.join(', ') : 'none'],
                ['Kubelet', n.kubeletVersion ?? '—'],
                ['Ready', n.ready ? 'yes' : 'no'],
              ]}
              note={sev === 'ok'
                ? `Healthy. Draining moves ${n.pods} pods to the remaining nodes.`
                : `Draining this node would need somewhere for ${n.pods} pods to go.`}
            />
          </Link>
        );
      })}
    </div>
  );
}

/* ── platform tiles ──────────────────────────────────────────────── */

type Summary = ReturnType<typeof useConsoleSummary>['data'] extends { data: infer T } | undefined ? T : never;
type Live = ReturnType<typeof useConsoleLive>['data'] extends { data: infer T } | undefined ? T : never;

function MailTile({ live }: { live: Live | undefined }) {
  const m = live?.mail.data;
  if (!m) return <SectionFallback title="Mail" to="/email/operations" section={live?.mail ?? { state: 'stale', reason: null, observedAt: null }} />;
  const cells: MatrixCell[] = [
    { k: 'Sent · 7d', v: m.sent7d.toLocaleString() },
    { k: 'Queue', v: m.queueReachable ? String(m.queueDepth) : 'unreachable', tone: m.queueReachable ? 'ok' : 'crit' },
    { k: 'Mailboxes', v: String(m.mailboxes), sub: `${m.emailDomains} domains` },
    { k: 'Over quota', v: String(m.overQuotaMailboxes), tone: m.overQuotaMailboxes > 0 ? 'crit' : 'ok' },
  ];
  return (
    <MatrixTile title="Mail" to="/email/operations" cells={cells} card={(
      <HoverCard title="Mail — last 7 days" rows={[
        ['Delivered', m.sent7d.toLocaleString()],
        ['Rate-limited', m.rateLimited7d.toLocaleString()],
        ['Mailboxes', String(m.mailboxes)],
        ['Email domains', String(m.emailDomains)],
        ['Mailboxes over quota', String(m.overQuotaMailboxes)],
      ]} note="At 100% of its quota a mailbox refuses inbound mail at RCPT TO." />
    )} />
  );
}

function WebDefenceTile({ live }: { live: Live | undefined }) {
  const w = live?.webDefence.data;
  if (!w) return <SectionFallback title="Web defence" to="/security/web-defense" section={live?.webDefence ?? { state: 'stale', reason: null, observedAt: null }} />;
  const cells: MatrixCell[] = [
    { k: 'Blocked · 24h', v: w.blocked24h.toLocaleString(), tone: w.blocked24h > 0 ? 'warn' : 'ok' },
    { k: 'Critical', v: w.critical24h.toLocaleString() },
    { k: 'Sources', v: String(w.distinctSources) },
    { k: 'Top rule', v: w.topRuleId ?? '—' },
  ];
  return (
    <MatrixTile title="Web defence" to="/security/web-defense" cells={cells} card={(
      <HoverCard title="Web defence — last 24 hours" rows={[
        ['Requests blocked', w.blocked24h.toLocaleString()],
        ['Critical', w.critical24h.toLocaleString()],
        ['Distinct sources', String(w.distinctSources)],
        ['Most hit rule', w.topRuleId ?? '—'],
      ]} note="Your own address may be allowlisted — a probe from here can read as a pass." />
    )} />
  );
}

function TenantsTile({ summary }: { summary: Summary | undefined }) {
  const t = summary?.tenants.data;
  if (!t) return <SectionFallback title="Tenants & workloads" to="/tenants" section={summary?.tenants ?? { state: 'stale', reason: null, observedAt: null }} />;
  const cells: MatrixCell[] = [
    { k: 'Active', v: String(t.active), sub: `of ${t.total}` },
    { k: 'Routes', v: String(t.routes) },
    { k: 'Domains', v: String(t.domains) },
    { k: 'Provisioning', v: String(t.provisioningInFlight), tone: t.provisioningInFlight > 0 ? 'warn' : undefined, sub: t.provisioningInFlight > 0 ? 'in flight' : undefined },
  ];
  return (
    <MatrixTile title="Tenants & workloads" to="/tenants" cells={cells} card={(
      <HoverCard title="Tenancy" rows={[
        ['Active tenants', String(t.active)],
        ['Total', String(t.total)],
        ['Ingress routes', String(t.routes)],
        ['Domains', String(t.domains)],
        ['Provisioning in flight', String(t.provisioningInFlight)],
      ]} note="A tenant above 90% of any limit opens one alert episode, not one per hour." />
    )} />
  );
}

function BackupsTile({ summary }: { summary: Summary | undefined }) {
  const b = summary?.backups.data;
  if (!b) return <SectionFallback title="Backups & DR" to="/backups" section={summary?.backups ?? { state: 'stale', reason: null, observedAt: null }} />;
  // Built on the three shim classes, not on one blended "backups are fine"
  // number: each routes to its own target and can go stale alone.
  const cells: MatrixCell[] = b.classes.map((c) => ({
    k: c.backupClass,
    v: c.lastSuccessAt ? ago(c.lastSuccessAt) : (c.healthy ? 'target set' : '—'),
    sub: c.lastSuccessAt ? 'ago' : undefined,
    tone: c.healthy ? 'ok' : 'warn',
  }));
  cells.push({ k: 'Bundles', v: b.bundles.toLocaleString() });
  return (
    <MatrixTile title="Backups & DR" to="/backups" cells={cells.slice(0, 4)} card={(
      <HoverCard title="Backup classes" rows={[
        ...b.classes.flatMap((c) => ([
          [`${c.backupClass} — last success`, c.lastSuccessAt ? `${ago(c.lastSuccessAt)} ago` : 'never recorded'],
          [`${c.backupClass} target`, c.targetName ? `${c.targetName} · ${c.targetKind ?? '?'}` : 'unassigned'],
        ] as Array<[string, string]>)),
        ['Bundles', b.bundles.toLocaleString()],
        ['Repository size', bytesToGb(b.repoBytes)],
        ['Tenants never backed up', String(b.tenantsNeverBackedUp)],
      ]} note="Each class routes to its own target independently — one can go stale without the other two noticing." />
    )} />
  );
}

/* ── operations tiles ────────────────────────────────────────────── */

function CertificatesTile({ summary }: { summary: Summary | undefined }) {
  const c = summary?.certificates.data;
  if (!c) return <SectionFallback title="Certificates" to="/domains" section={summary?.certificates ?? { state: 'stale', reason: null, observedAt: null }} />;
  return (
    <MatrixTile title="Certificates" to="/domains" cells={[
      { k: 'Issued', v: String(c.issued) },
      { k: 'Wildcards', v: String(c.wildcards), tone: 'ok' },
      { k: 'Nearest expiry', v: c.nearestExpiryDays == null ? '—' : `${c.nearestExpiryDays}d`,
        tone: c.nearestExpiryDays != null && c.nearestExpiryDays < 14 ? 'crit' : undefined },
      { k: 'Failing', v: String(c.failing), tone: c.failing > 0 ? 'crit' : 'ok' },
    ]} card={(
      <HoverCard title="TLS" rows={[
        ['Certificates', String(c.issued)],
        ['With a wildcard SAN', String(c.wildcards)],
        ['Nearest expiry', c.nearestExpiryDays == null ? '—' : `${c.nearestExpiryDays} days`],
        ['Renewal failures', String(c.failing)],
      ]} note="Wildcards cover webmail and autodiscover on tenant domains at no extra cost." />
    )} />
  );
}

function ScheduledTasksTile({ summary }: { summary: Summary | undefined }) {
  const t = summary?.scheduledTasks.data;
  if (!t) return <SectionFallback title="Scheduled" to="/platform/cron-jobs" section={summary?.scheduledTasks ?? { state: 'stale', reason: null, observedAt: null }} />;
  return (
    <MatrixTile title="Scheduled tasks" to="/platform/cron-jobs" cells={[
      { k: 'Jobs', v: String(t.total), sub: `${t.enabled} enabled` },
      { k: 'Failed · 24h', v: String(t.failed24h), tone: t.failed24h > 0 ? 'warn' : 'ok' },
      { k: 'Enabled', v: String(t.enabled) },
      { k: 'Overdue', v: String(t.overdue), tone: t.overdue > 0 ? 'warn' : undefined },
    ]} card={(
      <HoverCard title="Cron & platform jobs" rows={[
        ['Jobs', String(t.total)],
        ['Enabled', String(t.enabled)],
        ['Failures, 24h', String(t.failed24h)],
      ]} note="A job that has never succeeded shows an empty last-success, not a zero." />
    )} />
  );
}

function UpdatesTile({ summary }: { summary: Summary | undefined }) {
  const u = summary?.updates.data;
  if (!u) return <SectionFallback title="Updates" to="/platform/updates" section={summary?.updates ?? { state: 'stale', reason: null, observedAt: null }} />;
  return (
    <MatrixTile title="Updates" to="/platform/updates" cells={[
      { k: 'Platform', v: u.platformCurrent ? 'Current' : 'Behind', tone: u.platformCurrent ? 'ok' : 'warn' },
      { k: 'Apps behind', v: String(u.deploymentsBehind), tone: u.deploymentsBehind > 0 ? 'warn' : 'ok' },
      { k: 'Auto-upgrade', v: String(u.autoUpgradeEnabled) },
      { k: 'EOL runtimes', v: String(u.eolRuntimes), tone: u.eolRuntimes > 0 ? 'warn' : 'ok' },
    ]} card={(
      <HoverCard title="Available upgrades" rows={[
        ['Platform release', u.platformCurrent ? 'current' : 'behind'],
        ['Deployments behind', String(u.deploymentsBehind)],
        ['Auto-upgrade enabled', String(u.autoUpgradeEnabled)],
        ['Runtimes past end-of-life', String(u.eolRuntimes)],
      ]} note="Advisory locks let a tenant pin a version; blocking locks would refuse the upgrade." />
    )} />
  );
}

function ChangesTile({ summary }: { summary: Summary | undefined }) {
  const rows = summary?.recentChanges.data ?? [];
  return (
    <Tile title="Changes" to="/monitoring/audit-logs">
      <div className="flex flex-1 flex-col gap-px overflow-hidden rounded-lg bg-gray-200 dark:bg-gray-700">
        {rows.length === 0 ? (
          <p className="bg-white p-2.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">Nothing recorded.</p>
        ) : rows.slice(0, 5).map((r, i) => (
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
