import { ShieldCheck, AlertTriangle, ShieldAlert, Loader2 } from 'lucide-react';
import { useCnpgBackupHealth } from '@/hooks/use-cnpg-backup-health';
import type { CnpgClusterBackupHealth } from '@k8s-hosting/api-contracts';

interface Props {
  /**
   * Restrict the card to one cluster (e.g. "mail-pg" on the Email
   * Management page). When omitted, all watched clusters are shown.
   */
  readonly clusterFilter?: string;
}

/**
 * CNPG Backup CR health summary, surfaced on admin pages so operators
 * see when a CNPG cluster's daily/system-backup chain is broken WITHOUT
 * having to run kubectl. Phase 2A.2 of mail-subsystem hardening — closes
 * the gap that let mail-pg-daily-20260505031500 fail unnoticed.
 *
 * Visible states:
 *   - healthy       — green check, last success age
 *   - stale         — amber, last success > 24h ago
 *   - failing       — red, latest attempt failed (with error excerpt)
 *   - never_run     — amber, no Backup CRs ever
 *   - no_backup_config — red, ScheduledBackup exists but cluster lacks
 *                        spec.backup (the misconfiguration that prompted
 *                        this work).
 */
export function CnpgBackupHealthCard({ clusterFilter }: Props) {
  const { data, isLoading, error } = useCnpgBackupHealth();

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading backup health…
        </div>
      </div>
    );
  }

  if (error || !data?.data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Could not load backup health. Check platform-api logs.
          </div>
        </div>
      </div>
    );
  }

  const clusters = clusterFilter
    ? data.data.filter((c) => c.clusterName === clusterFilter)
    : data.data;

  if (clusters.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 text-sm text-gray-500 dark:text-gray-400">
        No CNPG clusters found{clusterFilter ? ` matching "${clusterFilter}"` : ''}.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4">
      <div className="flex items-center gap-3">
        <ShieldCheck size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100" data-testid="cnpg-backup-health-heading">
          Database Backup Health
        </h2>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        CNPG <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">Backup</code>{' '}
        CR status for managed PostgreSQL clusters. Daily +
        system-backup chains write to off-site S3 with 30-day retention.
        Restore via{' '}
        <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">scripts/reset-mail-pg.sh --restore-from-backup</code>.
      </p>

      <div className="space-y-3">
        {clusters.map((c) => (
          <ClusterRow key={`${c.namespace}/${c.clusterName}`} c={c} />
        ))}
      </div>
    </div>
  );
}

function ClusterRow({ c }: { c: CnpgClusterBackupHealth }) {
  const palette = paletteForState(c.state);

  return (
    <div
      className={`rounded-lg border ${palette.border} ${palette.bg} p-4 space-y-2`}
      data-testid={`cnpg-backup-health-cluster-${c.namespace}-${c.clusterName}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {palette.icon}
          <span className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
            {c.namespace}/{c.clusterName}
          </span>
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${palette.badge}`}>
            {labelForState(c.state)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-gray-700 dark:text-gray-300">
        <div>
          <span className="text-gray-500 dark:text-gray-400">Last successful:</span>{' '}
          {c.lastSuccessfulBackup ? (
            <span title={c.lastSuccessfulBackup.startedAt ?? ''}>
              {formatAge(c.lastSuccessSecondsAgo)} ago
            </span>
          ) : (
            <span className="italic">never</span>
          )}
        </div>
        <div>
          <span className="text-gray-500 dark:text-gray-400">ScheduledBackup CRs:</span>{' '}
          {c.scheduledBackups.length > 0 ? c.scheduledBackups.join(', ') : (
            <span className="italic">none</span>
          )}
        </div>
        {c.mostRecentFailure && (
          <div className="sm:col-span-2 rounded bg-red-100 dark:bg-red-900/30 px-2 py-1.5 text-red-800 dark:text-red-200">
            <div className="font-medium">Latest backup failed:</div>
            <div className="font-mono">{c.mostRecentFailure.name}</div>
            {c.mostRecentFailure.error && (
              <div className="mt-0.5">
                <span className="text-red-600 dark:text-red-300">Error:</span>{' '}
                {c.mostRecentFailure.error}
              </div>
            )}
          </div>
        )}
        {!c.clusterHasBackupSpec && (
          <div className="sm:col-span-2 rounded bg-red-100 dark:bg-red-900/30 px-2 py-1.5 text-red-800 dark:text-red-200">
            Cluster CR has no <code>spec.backup</code> section — backups
            cannot run. Re-apply backup-config from the admin panel or
            check Flux reconciliation.
          </div>
        )}
      </div>
    </div>
  );
}

function paletteForState(state: CnpgClusterBackupHealth['state']) {
  switch (state) {
    case 'healthy':
      return {
        border: 'border-green-200 dark:border-green-800',
        bg: 'bg-green-50 dark:bg-green-900/20',
        badge: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
        icon: <ShieldCheck size={14} className="text-green-600 dark:text-green-400" />,
      };
    case 'stale':
    case 'never_run':
      return {
        border: 'border-amber-300 dark:border-amber-700',
        bg: 'bg-amber-50 dark:bg-amber-900/20',
        badge: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
        icon: <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400" />,
      };
    case 'failing':
    case 'no_backup_config':
      return {
        border: 'border-red-300 dark:border-red-700',
        bg: 'bg-red-50 dark:bg-red-900/20',
        badge: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
        icon: <ShieldAlert size={14} className="text-red-600 dark:text-red-400" />,
      };
  }
}

function labelForState(state: CnpgClusterBackupHealth['state']): string {
  switch (state) {
    case 'healthy': return 'Healthy';
    case 'stale': return 'Stale';
    case 'failing': return 'Failing';
    case 'never_run': return 'Never run';
    case 'no_backup_config': return 'No config';
  }
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
