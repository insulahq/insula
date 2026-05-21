/**
 * Dashboard — incident-first surface (rebuilt 2026-05-21 Wave 3).
 *
 * Replaces the previous vanity dashboard (4 counters + tables that
 * duplicate Tenants and Nodes & Storage) with a "is the platform
 * broken right now?" page operators actually need during incidents.
 *
 * Composition (top to bottom):
 *   1. Health banner — single line, red/amber/green from /admin/health
 *   2. Incident stat cards — failed pods, recent 5xx, failing backups,
 *      in-flight lifecycle transitions
 *   3. Backup-freshness list — any backup with state != healthy
 *   4. In-flight transitions list — running / failed_blocking transitions
 *   5. Recent 5xx alerts (last 24h) — actionable audit-log entries
 *   6. Recent tenants — small table, "who joined this week"
 *
 * Pages this Dashboard intentionally does NOT duplicate (use the
 * sidebar instead):
 *   - Tenants list (Tenants page is the source of truth)
 *   - Cluster nodes (Nodes & Storage)
 *   - Domains (Domains page)
 */
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Archive,
  CheckCircle,
  Loader2,
  ServerCrash,
  ShieldAlert,
  Workflow,
  XCircle,
} from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge from '@/components/ui/StatusBadge';
import { useTenants } from '@/hooks/use-tenants';
import { useAuditLogs } from '@/hooks/use-audit-logs';
import { useBackupHealth } from '@/hooks/use-backup-health';
import { useHealth } from '@/hooks/use-health';
import { useLifecycleTransitions } from '@/hooks/use-lifecycle';
import { usePods } from '@/hooks/use-pods';

const ALERT_WINDOW_HOURS = 24;

export default function Dashboard() {
  const { data: tenantsResp, isLoading: tenantsLoading } = useTenants({ limit: 5 });
  const { data: healthResp } = useHealth();
  const { data: podsResp } = usePods();
  const { data: backupHealth } = useBackupHealth();
  // Show last 50 transitions; we filter in-flight client-side.
  const { data: lifecycleResp } = useLifecycleTransitions({ limit: 50, refetchInterval: 15_000 });
  // Pull a bigger window than the 24h slice so the count is accurate
  // when there are many recent audits (100 should comfortably cover).
  const { data: auditResp } = useAuditLogs({ limit: 100 });

  const tenants = tenantsResp?.data ?? [];
  const health = healthResp?.data;
  const pods = podsResp?.data?.pods ?? [];
  const transitions = lifecycleResp?.data?.transitions ?? [];
  const auditEntries = auditResp?.data ?? [];

  // ── Derived signals ───────────────────────────────────────────────
  const cutoff = Date.now() - ALERT_WINDOW_HOURS * 60 * 60 * 1000;
  const recent5xx = auditEntries.filter(
    (e) => e.httpStatus !== null && e.httpStatus >= 500 && new Date(e.createdAt).getTime() >= cutoff,
  );
  const failedPods = pods.filter(
    (p) => p.classification === 'failed' || p.classification === 'orphaned',
  );
  const failingBackups = (backupHealth ?? []).filter((b) => b.state === 'failing');
  const neverRunBackups = (backupHealth ?? []).filter((b) => b.state === 'never_run');
  const inflightTransitions = transitions.filter((t) => t.state === 'running');
  const failedTransitions = transitions.filter(
    (t) => t.state === 'failed_blocking' || t.state === 'failed_partial',
  );

  // Overall posture for the banner.
  const overall = health?.overall ?? 'healthy';
  const bannerTone =
    overall === 'healthy'
      ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200'
      : overall === 'degraded'
        ? 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200'
        : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200';
  const bannerIcon = overall === 'healthy' ? CheckCircle : overall === 'degraded' ? AlertTriangle : XCircle;
  const Icon = bannerIcon;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>

      {/* ── Health banner ───────────────────────────────────────── */}
      <div
        className={`rounded-md border px-4 py-3 flex items-center gap-3 ${bannerTone}`}
        data-testid="health-banner"
      >
        <Icon size={20} />
        <div className="flex-1">
          <div className="text-sm font-semibold capitalize">
            Platform: {overall}
          </div>
          {health && (
            <div className="text-xs opacity-80">
              {health.services.filter((s) => s.status === 'ok').length} / {health.services.length} services healthy
              {' · '}
              checked {new Date(health.checkedAt).toLocaleTimeString()}
            </div>
          )}
        </div>
        <Link
          to="/monitoring?tab=health"
          className="text-xs font-medium underline opacity-80 hover:opacity-100"
        >
          Health details →
        </Link>
      </div>

      {/* ── Incident stat cards ─────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div data-testid="stat-failed-pods">
          <StatCard
            title="Failed Pods"
            value={failedPods.length}
            subtitle={failedPods.length > 0 ? 'click to investigate' : 'all clear'}
            icon={ServerCrash}
            accent={failedPods.length > 0 ? 'red' : 'green'}
          />
        </div>
        <div data-testid="stat-5xx-alerts">
          <StatCard
            title={`5xx Alerts (${ALERT_WINDOW_HOURS}h)`}
            value={recent5xx.length}
            subtitle={recent5xx.length > 0 ? 'audit log filter →' : 'all clear'}
            icon={ShieldAlert}
            accent={recent5xx.length > 0 ? 'red' : 'green'}
          />
        </div>
        <div data-testid="stat-failing-backups">
          <StatCard
            title="Failing Backups"
            value={failingBackups.length}
            subtitle={
              failingBackups.length > 0
                ? `${failingBackups.length} failing, ${neverRunBackups.length} never-run`
                : neverRunBackups.length > 0
                  ? `${neverRunBackups.length} never run yet`
                  : 'all healthy'
            }
            icon={Archive}
            accent={failingBackups.length > 0 ? 'red' : neverRunBackups.length > 0 ? 'amber' : 'green'}
          />
        </div>
        <div data-testid="stat-transitions">
          <StatCard
            title="In-flight Transitions"
            value={inflightTransitions.length}
            subtitle={
              failedTransitions.length > 0
                ? `${failedTransitions.length} failed — needs operator`
                : inflightTransitions.length > 0
                  ? 'tenant lifecycle running'
                  : 'idle'
            }
            icon={Workflow}
            accent={failedTransitions.length > 0 ? 'red' : inflightTransitions.length > 0 ? 'amber' : 'green'}
          />
        </div>
      </div>

      {/* ── Incident detail cards: only render when something needs attention ── */}
      {(failingBackups.length > 0 || neverRunBackups.length > 0) && (
        <section
          className="rounded-md border border-amber-200 dark:border-amber-800 bg-white dark:bg-gray-900 p-4 space-y-2"
          data-testid="backup-incidents"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-200 flex items-center gap-2">
              <Archive size={16} /> Backup health
            </h2>
            <Link to="/backups/system" className="text-xs text-brand-600 dark:text-brand-400 hover:underline">
              Manage →
            </Link>
          </div>
          <ul className="text-xs space-y-1">
            {[...failingBackups, ...neverRunBackups].slice(0, 8).map((b) => (
              <li key={b.groupKey} className="flex items-center gap-2">
                <span className={`inline-block w-2 h-2 rounded-full ${b.state === 'failing' ? 'bg-red-500' : 'bg-amber-500'}`} />
                <span className="font-medium text-gray-900 dark:text-gray-100">{b.displayName}</span>
                <span className="text-gray-500 dark:text-gray-400">({b.category})</span>
                {b.lastFailedReason && (
                  <span className="text-gray-500 dark:text-gray-400 truncate max-w-md" title={b.lastFailedReason}>
                    — {b.lastFailedReason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {failedTransitions.length > 0 && (
        <section
          className="rounded-md border border-red-200 dark:border-red-800 bg-white dark:bg-gray-900 p-4 space-y-2"
          data-testid="failed-transitions"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-red-800 dark:text-red-200 flex items-center gap-2">
              <Workflow size={16} /> Failed tenant transitions
            </h2>
            <Link to="/settings/lifecycle-hooks" className="text-xs text-brand-600 dark:text-brand-400 hover:underline">
              Hook registry →
            </Link>
          </div>
          <ul className="text-xs space-y-1">
            {failedTransitions.slice(0, 5).map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <Link to={`/tenants/${t.tenantId}`} className="font-mono text-brand-600 dark:text-brand-400 hover:underline">
                  {t.tenantId.slice(0, 8)}
                </Link>
                <span className="text-gray-700 dark:text-gray-300">{t.transitionKind}</span>
                <span className="text-gray-500 dark:text-gray-400">{t.fromStatus ?? '?'} → {t.toStatus}</span>
                <span className="text-red-700 dark:text-red-300 font-medium">{t.state}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recent5xx.length > 0 && (
        <section
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 space-y-2"
          data-testid="recent-5xx"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <ShieldAlert size={16} /> Recent 5xx alerts (last {ALERT_WINDOW_HOURS}h)
            </h2>
            <Link to="/monitoring/audit-logs" className="text-xs text-brand-600 dark:text-brand-400 hover:underline">
              All audit logs →
            </Link>
          </div>
          <ul className="text-xs space-y-1 font-mono">
            {recent5xx.slice(0, 8).map((e) => (
              <li key={e.id} className="flex items-center gap-2">
                <span className="text-red-700 dark:text-red-300">{e.httpStatus}</span>
                <span className="text-gray-700 dark:text-gray-300">{e.httpMethod}</span>
                <span className="text-gray-900 dark:text-gray-100 truncate max-w-xl" title={e.httpPath ?? ''}>
                  {e.httpPath ?? '—'}
                </span>
                <span className="text-gray-500 dark:text-gray-400 ml-auto">
                  {new Date(e.createdAt).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Secondary: recent tenants (kept — "who joined this week" is a useful glance) ── */}
      <div
        className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
        data-testid="recent-tenants"
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Recent tenants</h2>
          <Link to="/tenants" className="text-xs text-brand-600 dark:text-brand-400 hover:underline">
            View all →
          </Link>
        </div>
        {tenantsLoading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={18} className="animate-spin text-gray-400" />
          </div>
        )}
        {!tenantsLoading && tenants.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
            No tenants yet.
          </div>
        )}
        {!tenantsLoading && tenants.length > 0 && (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800 text-xs">
            {tenants.slice(0, 5).map((t) => (
              <li key={t.id} className="flex items-center justify-between px-4 py-2">
                <div className="flex items-center gap-3">
                  <Link to={`/tenants/${t.id}`} className="font-medium text-gray-900 dark:text-gray-100 hover:text-brand-500">
                    {t.name}
                  </Link>
                  <span className="text-gray-500 dark:text-gray-400">{t.primaryEmail}</span>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={t.status} />
                  <span className="text-gray-400 dark:text-gray-500">
                    {t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
