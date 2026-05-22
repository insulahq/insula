import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, AlertTriangle, ShieldAlert, Loader2, Radio, RotateCw } from 'lucide-react';
import { useCnpgBackupHealth } from '@/hooks/use-cnpg-backup-health';
import { useWalArchiveClusters } from '@/hooks/use-system-wal-archive';
import { apiFetch } from '@/lib/api-client';
import BarmanRestoreWizard from '@/components/backups/BarmanRestoreWizard';
import type {
  CnpgBackupCatalogueResponse,
  CnpgClusterBackupHealth,
  WalArchiveCluster,
} from '@k8s-hosting/api-contracts';

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
  // P4c: WAL streaming health — surfaced as a per-cluster line below the
  // base backup info so the operator sees both signals together.
  const walQ = useWalArchiveClusters();
  // P4d (2026-05-22): when an operator clicks "Restore from this" on a
  // backup row, open BarmanRestoreWizard with the source + target time
  // pre-seeded. Local state lives in the card so the modal is portaled
  // outside the row's z-index.
  const [restoreFrom, setRestoreFrom] = useState<{
    sourceName: string;
    targetTime: string;
  } | null>(null);

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
          <ClusterRow
            key={`${c.namespace}/${c.clusterName}`}
            c={c}
            wal={walQ.data?.find((w) => w.clusterNamespace === c.namespace && w.clusterName === c.clusterName) ?? null}
            onRestoreFromBackup={(t: string) => setRestoreFrom({ sourceName: c.clusterName, targetTime: t })}
          />
        ))}
      </div>

      {restoreFrom && (
        <BarmanRestoreWizard
          onClose={() => setRestoreFrom(null)}
          initialSourceName={restoreFrom.sourceName}
          initialTargetTime={restoreFrom.targetTime}
        />
      )}
    </div>
  );
}

function ClusterRow({
  c,
  wal,
  onRestoreFromBackup,
}: {
  c: CnpgClusterBackupHealth;
  wal: WalArchiveCluster | null;
  onRestoreFromBackup: (targetTimeIso: string) => void;
}) {
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
        {/* P4c — WAL streaming line. Three states:
            - enabled + lastArchivedWalTime fresh → green Radio + age
            - enabled + lastFailedArchiveTime → red Radio + error
            - disabled / unknown → muted */}
        <div className="sm:col-span-2 flex items-center gap-2">
          {wal?.enabled && wal.status?.lastArchivedWalTime && !wal.status.lastFailedArchiveTime ? (
            <>
              <Radio size={12} className="text-emerald-600 dark:text-emerald-400" />
              <span className="text-gray-500 dark:text-gray-400">WAL streaming:</span>
              <span title={wal.status.lastArchivedWalTime} className="text-emerald-700 dark:text-emerald-300">
                last archived {formatAgoFromIso(wal.status.lastArchivedWalTime)} ago
              </span>
              {wal.status.lastArchivedWal && (
                <span className="font-mono text-[10px] text-gray-500 dark:text-gray-400">
                  ({wal.status.lastArchivedWal.length > 24 ? wal.status.lastArchivedWal.slice(0, 24) + '…' : wal.status.lastArchivedWal})
                </span>
              )}
            </>
          ) : wal?.enabled && wal.status?.lastFailedArchiveTime ? (
            <>
              <Radio size={12} className="text-rose-600 dark:text-rose-400" />
              <span className="text-gray-500 dark:text-gray-400">WAL streaming:</span>
              <span className="text-rose-700 dark:text-rose-300" title={wal.status.lastFailedArchiveError ?? ''}>
                FAILING — {formatAgoFromIso(wal.status.lastFailedArchiveTime)} ago
              </span>
            </>
          ) : wal?.enabled ? (
            <>
              <Radio size={12} className="text-amber-600 dark:text-amber-400" />
              <span className="text-gray-500 dark:text-gray-400">WAL streaming: enabled but no archive yet</span>
            </>
          ) : (
            <>
              <Radio size={12} className="text-gray-400 dark:text-gray-600" />
              <span className="text-gray-400 dark:text-gray-600">WAL streaming: disabled</span>
            </>
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
        {c.state === 'cnpg_operator_blind' && (
          <div className="sm:col-span-2 rounded bg-amber-100 dark:bg-amber-900/30 px-2 py-1.5 text-amber-900 dark:text-amber-200">
            <div className="font-medium">CNPG operator can&apos;t see this cluster&apos;s backups —
              but the object store has {c.objectStoreBackupCount ?? '?'} of them.</div>
            <div className="mt-0.5 text-amber-800 dark:text-amber-300">
              The shim&apos;s catalogue is reaching the upstream archive successfully.
              The cluster&apos;s control-plane projection has diverged — restart the
              CNPG operator pod (<code>kubectl -n cnpg-system rollout restart deploy/cnpg-cloudnative-pg</code>)
              and / or the postgres primary so it re-registers the plugin.
            </div>
          </div>
        )}
      </div>

      {/* P4d (2026-05-22): inline catalogue backup list with per-row
          Restore buttons. Only renders when the cluster has an
          ObjectStore (plugin-mode); legacy spec.backup-only clusters
          are out of scope for now. */}
      {c.objectStoreName && (
        <BackupListPanel
          namespace={c.namespace}
          objectStoreName={c.objectStoreName}
          onRestoreFromBackup={onRestoreFromBackup}
        />
      )}
    </div>
  );
}

function BackupListPanel({
  namespace,
  objectStoreName,
  onRestoreFromBackup,
}: {
  namespace: string;
  objectStoreName: string;
  onRestoreFromBackup: (targetTimeIso: string) => void;
}) {
  // P4d: lazy-disclosure pattern. The catalogue fetch is an S3 LIST +
  // per-backup GET so we only fire when the operator actually opens the
  // panel — otherwise N clusters × N visits to /backups/system would
  // produce N pointless requests per page-mount.
  const [expanded, setExpanded] = useState(false);
  const q = useQuery({
    queryKey: ['cnpg-backup-catalogue', namespace, objectStoreName],
    queryFn: () =>
      apiFetch<{ data: CnpgBackupCatalogueResponse }>(
        `/api/v1/admin/cnpg-backup-catalogue/${encodeURIComponent(namespace)}/${encodeURIComponent(objectStoreName)}`,
      ),
    staleTime: 60_000,
    retry: false,
    enabled: expanded,
  });
  const cat = q.data?.data;
  return (
    <details
      className="mt-2 rounded border border-gray-200 bg-white px-2 py-1 dark:border-gray-700 dark:bg-gray-900"
      onToggle={(e) => setExpanded((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300">
        Available backups in the object store{cat ? ` (${cat.backups.length})` : ''}
      </summary>
      <div className="mt-1.5">
        {q.isLoading && <div className="text-xs text-gray-500">Loading…</div>}
        {q.error && (
          <div className="text-xs text-rose-700">
            Catalogue fetch failed: {q.error instanceof Error ? q.error.message : String(q.error)}
          </div>
        )}
        {cat?.source === 'unavailable' && (
          <div className="text-xs text-amber-800 dark:text-amber-300">
            Catalogue unavailable: {cat.unavailableReason}
          </div>
        )}
        {cat?.source === 'object-store' && cat.backups.length === 0 && (
          <div className="text-xs text-gray-500 dark:text-gray-400">No backups in archive yet.</div>
        )}
        {cat?.source === 'object-store' && cat.backups.length > 0 && (
          <ul className="space-y-0.5 text-xs">
            {cat.backups.slice(0, 10).map((b) => {
              const targetTime = b.endedAt ?? b.uploadedAt ?? null;
              return (
                <li
                  key={b.backupId}
                  className="flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-800"
                  data-testid={`backup-row-${b.backupId}`}
                >
                  <span className="flex-shrink-0 font-mono text-[10px] text-gray-700 dark:text-gray-300">
                    {b.backupId}
                  </span>
                  <span className="flex-1 text-[10px] text-gray-500 dark:text-gray-400">
                    {targetTime ? new Date(targetTime).toLocaleString() : 'in-flight'}
                    {b.dataSizeBytes != null && (
                      <span className="ml-1">· {formatBytes(b.dataSizeBytes)}</span>
                    )}
                    {b.status && b.status !== 'DONE' && (
                      <span className="ml-1 text-amber-700 dark:text-amber-400">[{b.status}]</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => targetTime && onRestoreFromBackup(targetTime)}
                    disabled={!targetTime}
                    title={targetTime ? `Open the restore wizard with target time pre-set to ${new Date(targetTime).toISOString()}` : 'Backup is in-flight — wait until it completes'}
                    className="inline-flex items-center gap-1 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    data-testid={`backup-restore-${b.backupId}`}
                  >
                    <RotateCw size={9} /> Restore from this
                  </button>
                </li>
              );
            })}
            {cat.backups.length > 10 && (
              <li className="px-1.5 py-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                + {cat.backups.length - 10} older backups (truncated)
              </li>
            )}
          </ul>
        )}
      </div>
    </details>
  );
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MiB`;
  return `${(b / 1024).toFixed(0)} KiB`;
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
    case 'cnpg_operator_blind':
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
    case 'cnpg_operator_blind': return 'Operator blind';
  }
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatAgoFromIso(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'unknown';
  return formatAge(Math.floor(ms / 1000));
}
