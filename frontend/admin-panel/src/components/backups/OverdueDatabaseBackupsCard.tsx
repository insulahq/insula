import { DatabaseZap } from 'lucide-react';
import { useOverdueDatabaseBackups } from '@/hooks/use-database-backups';
import { DatabaseBackupsTable, ShowMore } from '@/components/tenant-detail/DatabaseBackupsCard';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

/**
 * Tenant databases with no good backup in the latest scheduled run that has
 * had time to finish, across every tenant — where the "Tenant database
 * backups overdue" alert lands when it lists more than one tenant. Renders
 * nothing when there are none; says so when it cannot tell.
 */
export default function OverdueDatabaseBackupsCard() {
  const q = useOverdueDatabaseBackups();
  if (q.error) {
    return (
      <ErrorPanel
        error={extractOperatorError(q.error)}
        onRetry={() => { void q.refetch(); }}
        compact
        severity="warn"
        testId="overdue-database-backups-error"
      />
    );
  }
  const overdue = q.data?.pages.flatMap((p) => p.data ?? []) ?? [];
  if (overdue.length === 0) return null;
  return (
    <section
      className="rounded-xl border border-red-200 bg-red-50/60 dark:border-red-800 dark:bg-red-900/10"
      data-testid="overdue-database-backups-card"
    >
      <div className="px-5 pt-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-red-900 dark:text-red-200">
          <DatabaseZap size={15} aria-hidden="true" /> Database backups overdue ({overdue.length}{q.hasNextPage ? '+' : ''})
        </h3>
        <p className="mt-1 text-[13px] text-red-800 dark:text-red-300">
          These databases had no good backup in the latest scheduled backup run.
          Their data files in the files snapshot are copied from the running server and are not guaranteed to restore.
        </p>
      </div>
      <div className="mt-3 overflow-x-auto">
        <DatabaseBackupsTable databases={overdue} showTenant />
        <ShowMore hasNextPage={q.hasNextPage} isFetchingNextPage={q.isFetchingNextPage} fetchNextPage={q.fetchNextPage} />
      </div>
    </section>
  );
}
