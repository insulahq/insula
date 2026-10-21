/**
 * What a backup target holds and how much room it has left — the dashboard's
 * per-target tile and the targets page's summary line.
 *
 * Every number is the last measurement of the target itself (rclone size per
 * class folder, rclone about for the free space; backup-config/target-usage.ts),
 * shown with when it was taken. A target that cannot report free space (S3)
 * says so rather than showing a guess.
 */
import { Loader2, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import type { BackupUsageClass, TargetUsageRow } from '@insula/api-contracts';
import { formatBytes } from '@/lib/format-snapshot-size';

const CLASS_LABEL: Record<BackupUsageClass, string> = { system: 'System', tenant: 'Tenants', mail: 'Mail' };
const CLASS_BAR: Record<BackupUsageClass, string> = {
  system: 'bg-indigo-500 dark:bg-indigo-400',
  tenant: 'bg-emerald-500 dark:bg-emerald-400',
  mail: 'bg-amber-500 dark:bg-amber-400',
};
const KIND_LABEL: Record<string, string> = { s3: 'S3', ssh: 'SFTP', cifs: 'SMB/CIFS' };

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "120.4 GB free of 1.0 TB" — or why there is no such figure. */
export function freeSpaceText(row: TargetUsageRow): string {
  const cap = row.usage?.capacity;
  if (cap?.freeBytes != null && cap.totalBytes != null) return `${formatBytes(cap.freeBytes)} free of ${formatBytes(cap.totalBytes)}`;
  if (cap?.freeBytes != null) return `${formatBytes(cap.freeBytes)} free`;
  return row.usage?.capacityNote ? `Free space: ${row.usage.capacityNote}` : 'Free space: not measured';
}

function MeasuredLine({ row, onMeasure, measurePending }: {
  readonly row: TargetUsageRow;
  readonly onMeasure?: () => void;
  readonly measurePending?: boolean;
}) {
  const measuring = Boolean(row.measuringSince) || measurePending;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
      {measuring ? (
        <span className="inline-flex items-center gap-1.5" data-testid={`target-usage-measuring-${row.targetId}`}>
          <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Measuring…
        </span>
      ) : (
        <span>{row.usage ? `Measured ${timeAgo(row.usage.measuredAt)}` : 'Not measured yet'}</span>
      )}
      {onMeasure && (
        <button
          type="button"
          onClick={onMeasure}
          disabled={measuring}
          className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-brand-400"
          data-testid={`target-usage-measure-${row.targetId}`}
        >
          <RefreshCw size={12} aria-hidden="true" /> Measure now
        </button>
      )}
    </div>
  );
}

/** The dashboard tile: total, free space, and one bar per class. */
export function TargetStorageTile({ row, onMeasure, measurePending }: {
  readonly row: TargetUsageRow;
  readonly onMeasure?: () => void;
  readonly measurePending?: boolean;
}) {
  const usage = row.usage;
  const cap = usage?.capacity ?? null;
  const usedPct = cap?.totalBytes && cap.usedBytes != null ? Math.min(100, (cap.usedBytes / cap.totalBytes) * 100) : null;
  const total = usage?.usedByBackupsBytes ?? 0;
  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      data-testid={`target-usage-tile-${row.targetId}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{row.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {KIND_LABEL[row.storageType] ?? row.storageType}
            {!row.enabled && ' · disabled'}
            {row.readOnly && ' · read-only'}
          </div>
        </div>
        {row.boundClasses.length > 0 && (
          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            {row.boundClasses.map((c) => CLASS_LABEL[c]).join(' · ')}
          </span>
        )}
      </div>

      {usage ? (
        <>
          <div>
            <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100" data-testid={`target-usage-total-${row.targetId}`}>
              {formatBytes(total)}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">used by backups, all classes</div>
          </div>

          <div>
            {usedPct !== null && (
              <div className="mb-1 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700" aria-hidden="true">
                <div
                  className={clsx('h-full rounded-full', usedPct >= 90 ? 'bg-red-500' : usedPct >= 75 ? 'bg-amber-500' : 'bg-brand-500')}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
            )}
            <div
              className={clsx('text-xs', cap?.freeBytes != null ? 'font-medium text-gray-800 dark:text-gray-200' : 'text-gray-500 dark:text-gray-400')}
              data-testid={`target-usage-free-${row.targetId}`}
            >
              {freeSpaceText(row)}
            </div>
          </div>

          <ul className="space-y-1.5" aria-label={`Storage per class on ${row.name}`}>
            {(['system', 'tenant', 'mail'] as const).map((cls) => {
              const c = usage.classes[cls];
              const pct = c && total > 0 ? (c.bytes / total) * 100 : 0;
              return (
                <li key={cls} className="text-xs" data-testid={`target-usage-class-${row.targetId}-${cls}`}>
                  <div className="flex justify-between gap-2">
                    <span className="text-gray-700 dark:text-gray-300">{CLASS_LABEL[cls]}</span>
                    <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">
                      {c ? formatBytes(c.bytes) : <span className="text-amber-700 dark:text-amber-400" title={usage.errors[cls]}>not listed</span>}
                    </span>
                  </div>
                  <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700" aria-hidden="true">
                    <div className={clsx('h-full rounded-full', CLASS_BAR[cls])} style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">Not measured yet. Targets are measured every 6 hours, the first time shortly after platform-api starts.</p>
      )}

      <MeasuredLine row={row} onMeasure={onMeasure} measurePending={measurePending} />
    </div>
  );
}

/** One line for a target card on the targets page. */
export function TargetStorageSummary({ row, onMeasure, measurePending }: {
  readonly row: TargetUsageRow | undefined;
  readonly onMeasure?: () => void;
  readonly measurePending?: boolean;
}) {
  if (!row) return null;
  const usage = row.usage;
  return (
    <div className="space-y-1 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-900/40" data-testid={`target-usage-summary-${row.targetId}`}>
      {usage ? (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span className="text-gray-900 dark:text-gray-100">
            <span className="font-semibold">{formatBytes(usage.usedByBackupsBytes)}</span> used by backups
          </span>
          <span className={usage.capacity?.freeBytes != null ? 'font-medium text-gray-800 dark:text-gray-200' : 'text-gray-500 dark:text-gray-400'}>
            {freeSpaceText(row)}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {(['system', 'tenant', 'mail'] as const)
              .map((cls) => `${CLASS_LABEL[cls]} ${usage.classes[cls] ? formatBytes(usage.classes[cls]!.bytes) : '—'}`)
              .join(' · ')}
          </span>
        </div>
      ) : (
        <div className="text-sm text-gray-500 dark:text-gray-400">Storage not measured yet.</div>
      )}
      <MeasuredLine row={row} onMeasure={onMeasure} measurePending={measurePending} />
    </div>
  );
}
