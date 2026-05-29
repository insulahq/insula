/**
 * SystemBackupListSection — Phase 3 (2026-05-24).
 *
 * Previously inline-disclosure inside CnpgBackupHealthCard. Lifted to
 * a page-level sibling so the backup list is always visible (operator
 * complaint: "I want to see the list of backups in the current
 * backup target as a section, not inside the health card").
 *
 * Renders the catalogue for ONE cluster — platform/system-db — as
 * the only CNPG cluster on the platform (mail-db was retired in
 * Phase 0a). A multi-cluster setup would loop the cluster list
 * from /admin/cnpg-backup-health.
 *
 * Columns: Date | Description | Size + per-row "Restore from this"
 * which opens BarmanRestoreWizard with the source + targetTime
 * pre-seeded (preserves the existing wiring from the lifted panel).
 *
 * Catalogue fetch shares the queryKey with CnpgBackupHealthCard's
 * BackupSizeTotal cell so TanStack Query dedups the request.
 */

import { useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Database, RotateCw, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { useCnpgBackupHealth } from '@/hooks/use-cnpg-backup-health';
import BarmanRestoreWizard from '@/components/backups/BarmanRestoreWizard';
import type { CnpgBackupCatalogueResponse } from '@insula/api-contracts';

/**
 * Resolve the (namespace, objectStoreName) pair to query for backups.
 * Reads cnpg-backup-health to find the live ObjectStore name attached
 * to platform/system-db — never hardcoded so a future name change
 * (e.g. system-postgres-objectstore → system-db-objectstore) doesn't
 * require a code edit.
 */
function useSystemDbObjectStoreRef(): {
  ns: string;
  cluster: string;
  objectStoreName: string | null;
  loading: boolean;
} {
  const { data, isLoading } = useCnpgBackupHealth();
  const row = data?.data?.find(
    (c) => c.namespace === 'platform' && c.clusterName === 'system-db',
  );
  return {
    ns: 'platform',
    cluster: 'system-db',
    objectStoreName: row?.objectStoreName ?? null,
    loading: isLoading,
  };
}

export default function SystemBackupListSection() {
  const ref = useSystemDbObjectStoreRef();
  const [restoreFrom, setRestoreFrom] = useState<{
    sourceName: string;
    targetTime: string;
  } | null>(null);

  return (
    <section
      className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      data-testid="system-backup-list-section"
    >
      <header className="mb-3 flex items-center gap-2">
        <Database size={18} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Backups in current target
        </h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          ({ref.cluster})
        </span>
      </header>

      {ref.loading && (
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>
      )}
      {!ref.loading && !ref.objectStoreName && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <div>
              No <code>ObjectStore</code> attached to{' '}
              <code>{ref.ns}/{ref.cluster}</code>. Enable WAL streaming on{' '}
              <code>/backups/system?tab=routing</code> to wire the cluster
              to an off-site target.
            </div>
          </div>
        </div>
      )}
      {!ref.loading && ref.objectStoreName && (
        <BackupTable
          namespace={ref.ns}
          objectStoreName={ref.objectStoreName}
          sourceClusterName={ref.cluster}
          onRestoreFromBackup={(t) =>
            setRestoreFrom({ sourceName: ref.cluster, targetTime: t })
          }
        />
      )}

      {restoreFrom && (
        <BarmanRestoreWizard
          onClose={() => setRestoreFrom(null)}
          initialSourceName={restoreFrom.sourceName}
          initialTargetTime={restoreFrom.targetTime}
        />
      )}
    </section>
  );
}

function BackupTable({
  namespace,
  objectStoreName,
  sourceClusterName,
  onRestoreFromBackup,
}: {
  namespace: string;
  objectStoreName: string;
  sourceClusterName: string;
  onRestoreFromBackup: (targetTimeIso: string) => void;
}) {
  // Shared queryKey with CnpgBackupHealthCard.BackupSizeTotal — TanStack
  // Query dedups so this view + the total-size cell cost a single LIST.
  const q = useQuery({
    queryKey: ['cnpg-backup-catalogue', namespace, objectStoreName],
    queryFn: () =>
      apiFetch<{ data: CnpgBackupCatalogueResponse }>(
        `/api/v1/admin/cnpg-backup-catalogue/${encodeURIComponent(namespace)}/${encodeURIComponent(objectStoreName)}`,
      ),
    staleTime: 60_000,
    retry: false,
  });

  if (q.isLoading) {
    return <div className="text-sm text-gray-500 dark:text-gray-400">Loading catalogue…</div>;
  }
  if (q.error) {
    return (
      <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
        Catalogue fetch failed: {q.error instanceof Error ? q.error.message : String(q.error)}
      </div>
    );
  }
  const cat = q.data?.data;
  if (cat?.source === 'unavailable') {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
        Catalogue unavailable: {cat.unavailableReason ?? '(no reason given)'}
      </div>
    );
  }
  if (!cat || cat.backups.length === 0) {
    return (
      <div className="text-sm italic text-gray-500 dark:text-gray-400">
        No backups in the archive yet. Use the &ldquo;Backup Now&rdquo;
        button at the top of the page to seed the target.
      </div>
    );
  }

  // Newest first — endedAt OR uploadedAt OR startedAt fallback. CNPG's
  // catalogue is typically already ordered but we sort defensively.
  const sorted = [...cat.backups].sort((a, b) => {
    const at = a.endedAt ?? a.uploadedAt ?? a.startedAt ?? '';
    const bt = b.endedAt ?? b.uploadedAt ?? b.startedAt ?? '';
    return bt.localeCompare(at);
  });

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700">
            <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Date
            </th>
            <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Description
            </th>
            <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Size
            </th>
            <th className="px-2 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {sorted.map((b) => {
            const targetTime = b.endedAt ?? b.uploadedAt ?? null;
            const dateStr = targetTime
              ? new Date(targetTime).toLocaleString()
              : 'in-flight';
            return (
              <tr key={b.backupId} data-testid={`backup-row-${b.backupId}`}>
                <td className="px-2 py-2 text-xs text-gray-700 dark:text-gray-300" title={targetTime ?? ''}>
                  {dateStr}
                </td>
                <td className="px-2 py-2 text-xs text-gray-700 dark:text-gray-300">
                  {describeBackup(b)}
                </td>
                <td className="px-2 py-2 text-xs text-gray-700 dark:text-gray-300">
                  {b.dataSizeBytes != null ? formatBytes(b.dataSizeBytes) : '—'}
                </td>
                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => targetTime && onRestoreFromBackup(targetTime)}
                    disabled={!targetTime}
                    title={
                      targetTime
                        ? `Open the restore wizard with target time pre-set to ${new Date(targetTime).toISOString()}`
                        : 'Backup is in-flight — wait until it completes'
                    }
                    className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    data-testid={`backup-restore-${b.backupId}`}
                  >
                    <RotateCw size={10} /> Restore from this
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
        Source: <code>{sourceClusterName}</code> · target object store{' '}
        <code>{objectStoreName}</code> · {cat.backups.length} backup
        {cat.backups.length === 1 ? '' : 's'}.
      </div>
    </div>
  );
}

/**
 * Phase 7b (2026-05-24) — operator-friendly description rendering.
 *
 * Priority order:
 *   1. Operator-supplied description (CR label) → render as-is.
 *      Example: "pre-upgrade"
 *   2. CR kind from labels:
 *      - 'scheduled'   → "Scheduled Backup"
 *      - 'on-demand'   → "On-demand backup"  (description was empty)
 *      - 'pre-restore' → "Pre-restore checkpoint"
 *   3. Fall back to backupId name-pattern (legacy backups without CRs
 *      labelled per Phase 7b).
 *
 * Failed/in-flight status appended in red.
 */
function describeBackup(b: {
  backupId: string;
  status: string | null;
  description?: string | null;
  kind?: 'scheduled' | 'on-demand' | 'pre-restore' | 'unknown' | null;
}): ReactElement {
  const failed = b.status && b.status !== 'DONE' && b.status !== 'COMPLETED';
  let label: string;
  if (b.description) {
    label = b.description;
  } else if (b.kind === 'scheduled') {
    label = 'Scheduled Backup';
  } else if (b.kind === 'on-demand') {
    label = 'On-demand backup';
  } else if (b.kind === 'pre-restore') {
    label = 'Pre-restore checkpoint';
  } else if (b.backupId.startsWith('on-demand-')) {
    label = 'On-demand backup';
  } else if (b.backupId.startsWith('pre-restore-')) {
    label = 'Pre-restore checkpoint';
  } else if (b.backupId.includes('-daily-') || b.backupId.includes('-scheduled-')) {
    label = 'Scheduled Backup';
  } else if (/^\d{8}T\d{6}$/.test(b.backupId)) {
    // Phase 8 (2026-05-25) — pure barman timestamp (YYYYMMDDTHHMMSS).
    // The CR that would have told us the kind has been GC'd by CNPG
    // (CRs don't survive past a few days under default settings).
    // Best-effort label: scheduled backups are by far the most common
    // anonymous timestamp source. Operators can still match against
    // the Date column if they need to be sure.
    label = 'Scheduled Backup';
  } else {
    label = b.backupId;
  }
  return (
    <span>
      {label}
      {failed && (
        <span className="ml-1 text-rose-700 dark:text-rose-400">[{b.status}]</span>
      )}
    </span>
  );
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MiB`;
  return `${(b / 1024).toFixed(0)} KiB`;
}
