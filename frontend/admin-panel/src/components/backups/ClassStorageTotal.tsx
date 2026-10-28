/**
 * The storage one backup class takes, on every target that holds any — the
 * headline of each class page.
 *
 * Taken from the target measurement (the class folder on each target,
 * backup-config/target-usage.ts; summed by `classStoredTotal`, which the
 * dashboard reads too), so it is what is actually stored. The figures further
 * down a page count less, and say what: the per-tenant rows show each
 * repository's own size, the mail card restic's count of the data its kept
 * snapshots use, the Postgres card the base copies alone.
 */
import { HardDrive, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { classStoredTotal, type BackupUsageClass } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { formatBytes } from '@/lib/format-bytes';
import { useBackupTargetUsage } from '@/hooks/use-backup-config';
import { timeAgo } from './TargetStorage';

const CAPTION: Record<BackupUsageClass, string> = {
  system: 'Storage used by system backups',
  tenant: 'Storage used by all tenant backups',
  mail: 'Storage used by mail backups',
};
const CONTENTS: Record<BackupUsageClass, string | null> = {
  system: 'database base copies and write-ahead log, etcd snapshots, DR bundles',
  tenant: null,
  mail: 'the mail store’s restic repository',
};
const ICON: Record<BackupUsageClass, string> = {
  system: 'text-indigo-600 dark:text-indigo-400',
  tenant: 'text-emerald-600 dark:text-emerald-400',
  mail: 'text-amber-600 dark:text-amber-400',
};

export default function ClassStorageTotal({ cls }: { readonly cls: BackupUsageClass }) {
  const { data, isLoading, error, refetch, isFetching } = useBackupTargetUsage();
  const { bytes, holders, unlisted, unmeasured, measuredAt } = classStoredTotal(data?.data.targets ?? [], cls);
  const id = `${cls}-storage-total`;
  const link = 'font-medium text-brand-600 hover:underline dark:text-brand-400';

  // A failed read is not "never measured": with no figure to show, say what failed.
  if (error && !data) {
    return (
      <ErrorPanel
        error={extractOperatorError(error)}
        severity="warn"
        compact
        onRetry={() => { void refetch(); }}
        retryPending={isFetching}
        testId={`${id}-error`}
      />
    );
  }

  return (
    <section
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      aria-label={CAPTION[cls]}
      data-testid={id}
    >
      <div className="flex items-center gap-3">
        <HardDrive size={18} className={ICON[cls]} aria-hidden="true" />
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{CAPTION[cls]}</div>
          {isLoading ? (
            <div className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={12} className="animate-spin" /> Loading…</div>
          ) : holders.length === 0 && unlisted.length > 0 ? (
            // Measured, but the class folder could not be walked: no figure, and not "never measured".
            <div className="text-sm text-amber-700 dark:text-amber-400" data-testid={`${id}-unlisted`}>
              Could not be listed on {unlisted.map((t) => t.name).join(', ')}
              {unlisted[0].error ? `: ${unlisted[0].error}` : ''} —{' '}
              <Link to="/backups/targets" className={link}>measure again</Link>
            </div>
          ) : holders.length === 0 ? (
            <div className="text-sm text-gray-600 dark:text-gray-400" data-testid={`${id}-none`}>
              Not measured yet — <Link to="/backups/targets" className={link}>measure a target</Link>
            </div>
          ) : (
            <div className="text-xl font-semibold text-gray-900 dark:text-gray-100" data-testid={`${id}-bytes`}>{formatBytes(bytes)}</div>
          )}
        </div>
      </div>
      {holders.length > 0 && (
        <div className="text-xs text-gray-600 dark:text-gray-400">
          {CONTENTS[cls] && <span className="block">{CONTENTS[cls]}</span>}
          <span>
            {holders.length > 1
              ? holders.map((h) => `${formatBytes(h.bytes)} on ${h.name}`).join(' · ')
              : `on ${holders[0].name}`}
            {' · '}measured {timeAgo(measuredAt)}
          </span>
          {unlisted.length > 0 && (
            <span className="ml-1 text-amber-700 dark:text-amber-400">· {unlisted.map((t) => t.name).join(', ')} could not be listed</span>
          )}
          {unmeasured.length > 0 && (
            <span className="ml-1 text-amber-700 dark:text-amber-400" data-testid={`${id}-unmeasured`}>
              · {unmeasured.map((t) => t.name).join(', ')} not measured yet
            </span>
          )}
        </div>
      )}
    </section>
  );
}
