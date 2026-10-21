/**
 * The storage all tenant backups take, on every target that holds any.
 *
 * Taken from the target measurement (the `tenant` class folder on each
 * target, backup-config/target-usage.ts) — what is actually stored: every
 * tenant's repositories and bundle files, deleted tenants' still within
 * retention, and anything a class switch left on a previous target. The
 * per-tenant rows below show each repository's own size, so they need not add
 * up to this exactly.
 */
import { HardDrive, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatBytes } from '@/lib/format-snapshot-size';
import { useBackupTargetUsage } from '@/hooks/use-backup-config';
import { timeAgo } from './TargetStorage';

export default function TenantStorageTotal() {
  const { data, isLoading } = useBackupTargetUsage();
  const holding = (data?.data.targets ?? [])
    .filter((t) => t.usage?.classes.tenant && (t.usage.classes.tenant.bytes > 0 || t.boundClasses.includes('tenant')));
  const total = holding.reduce((n, t) => n + (t.usage?.classes.tenant?.bytes ?? 0), 0);
  const oldest = holding.map((t) => t.usage!.measuredAt).sort()[0] ?? null;
  const unlisted = (data?.data.targets ?? []).filter((t) => t.boundClasses.includes('tenant') && t.usage && !t.usage.classes.tenant);

  return (
    <section
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      aria-label="Storage used by tenant backups"
      data-testid="tenant-storage-total"
    >
      <div className="flex items-center gap-3">
        <HardDrive size={18} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Storage used by all tenant backups</div>
          {isLoading ? (
            <div className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={12} className="animate-spin" /> Loading…</div>
          ) : holding.length === 0 ? (
            <div className="text-sm text-gray-600 dark:text-gray-400" data-testid="tenant-storage-total-none">
              Not measured yet — <Link to="/backups/targets" className="font-medium text-brand-600 hover:underline dark:text-brand-400">measure a target</Link>
            </div>
          ) : (
            <div className="text-xl font-semibold text-gray-900 dark:text-gray-100" data-testid="tenant-storage-total-bytes">{formatBytes(total)}</div>
          )}
        </div>
      </div>
      {holding.length > 0 && (
        <div className="text-xs text-gray-600 dark:text-gray-400">
          {holding.length > 1
            ? holding.map((t) => `${formatBytes(t.usage!.classes.tenant!.bytes)} on ${t.name}`).join(' · ')
            : `on ${holding[0].name}`}
          {' · '}measured {timeAgo(oldest)}
          {unlisted.length > 0 && (
            <span className="ml-1 text-amber-700 dark:text-amber-400">· {unlisted.map((t) => t.name).join(', ')} could not be listed</span>
          )}
        </div>
      )}
    </section>
  );
}
