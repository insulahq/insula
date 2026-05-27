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
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  CheckCircle,
  Container,
  Loader2,
  ServerCrash,
  ShieldAlert,
  Workflow,
  X,
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
import { usePlatformStatus } from '@/hooks/use-dashboard';
import { usePlatformImages } from '@/hooks/use-platform-images';

const ALERT_WINDOW_HOURS = 24;

export default function Dashboard() {
  const [showImagesModal, setShowImagesModal] = useState(false);
  const { data: tenantsResp, isLoading: tenantsLoading } = useTenants({ limit: 5 });
  const { data: healthResp } = useHealth();
  const { data: statusResp } = usePlatformStatus();
  const { data: podsResp } = usePods();
  const { data: backupHealth } = useBackupHealth();
  // Show last 50 transitions; we filter in-flight client-side.
  const { data: lifecycleResp } = useLifecycleTransitions({ limit: 50, refetchInterval: 15_000 });
  // Pull a bigger window than the 24h slice so the count is accurate
  // when there are many recent audits (100 should comfortably cover).
  // useAuditLogs already polls every 30s internally — acceptable on
  // an operator-stare-during-incidents page.
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
  // Distinct categories — both worth surfacing but mean different
  // operator actions ("investigate crash" vs "clean up dangling pod").
  const failedPods = pods.filter((p) => p.classification === 'failed');
  const orphanedPods = pods.filter((p) => p.classification === 'orphaned');
  const podsNeedingAttention = failedPods.length + orphanedPods.length;
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

  const platformStatus = statusResp?.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Dashboard</h1>
        {/* Platform info strip (moved from /settings on the Cluster + Platform
            Settings cleanup, 2026-05-27). Compact line — version + a button
            into the Deployed Images modal. Health/status data already lives
            in the banner below; this strip only carries non-incident reference
            data. */}
        <div
          className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400"
          data-testid="dashboard-platform-strip"
        >
          {platformStatus && (
            <span>
              <span className="text-gray-700 dark:text-gray-300">v{platformStatus.version}</span>
              {' · '}checked {platformStatus.timestamp ? new Date(platformStatus.timestamp).toLocaleTimeString() : '—'}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowImagesModal(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600"
            data-testid="show-deployed-images-button"
          >
            <Container size={12} />
            Deployed Images
          </button>
        </div>
      </div>

      {showImagesModal && <DeployedImagesModal onClose={() => setShowImagesModal(false)} />}

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
            title="Failed / Orphaned Pods"
            value={podsNeedingAttention}
            subtitle={
              podsNeedingAttention === 0
                ? 'all clear'
                : `${failedPods.length} failed · ${orphanedPods.length} orphaned`
            }
            icon={ServerCrash}
            accent={failedPods.length > 0 ? 'red' : orphanedPods.length > 0 ? 'amber' : 'green'}
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
            <Link to="/platform/lifecycle-hooks" className="text-xs text-brand-600 dark:text-brand-400 hover:underline">
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

/**
 * Deployed Images modal — same content as the legacy Settings page
 * carried, now triggered from the Dashboard's Platform info strip and
 * from /platform/updates. Lazy-loaded — usePlatformImages only runs
 * while the modal is mounted.
 */
function DeployedImagesModal({ onClose }: { readonly onClose: () => void }) {
  const { data, isLoading, isError } = usePlatformImages();
  const images = data?.data ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-xl bg-white dark:bg-gray-800 shadow-xl flex flex-col"
        data-testid="platform-images-modal"
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <div className="flex items-center gap-2">
            <Container size={20} className="text-gray-600 dark:text-gray-400" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Deployed Images</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex items-center gap-2 py-8 justify-center">
              <Loader2 size={16} className="animate-spin text-gray-400" />
              <span className="text-sm text-gray-500 dark:text-gray-400">Loading image inventory…</span>
            </div>
          ) : isError ? (
            <p className="text-sm text-red-600 dark:text-red-400">Failed to load image inventory.</p>
          ) : images.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No images enumerated. The backend may lack cluster read permissions.
            </p>
          ) : (
            <table className="min-w-full text-sm" data-testid="platform-images-table">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                  <th className="px-2 py-2 font-medium">Component</th>
                  <th className="px-2 py-2 font-medium">Namespace</th>
                  <th className="px-2 py-2 font-medium">Image</th>
                  <th className="px-2 py-2 font-medium">Tag</th>
                  <th className="px-2 py-2 font-medium text-right">Ready</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {images.map((row) => (
                  <tr key={`${row.namespace}/${row.component}/${row.image}`}>
                    <td className="px-2 py-2 text-gray-900 dark:text-gray-100 font-medium">{row.component}</td>
                    <td className="px-2 py-2 text-gray-600 dark:text-gray-400 font-mono text-xs">{row.namespace}</td>
                    <td className="px-2 py-2 text-gray-600 dark:text-gray-400 font-mono text-xs break-all">{row.image}</td>
                    <td className="px-2 py-2 text-gray-900 dark:text-gray-100 font-mono text-xs">{row.tag}</td>
                    <td className="px-2 py-2 text-right">
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium ${
                          row.healthy ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {row.running}/{row.desired}
                        {row.healthy ? <CheckCircle size={12} /> : <AlertCircle size={12} />}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
