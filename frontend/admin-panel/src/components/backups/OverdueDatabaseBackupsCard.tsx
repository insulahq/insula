import { DatabaseZap } from 'lucide-react';
import { useOverdueDatabaseBackups } from '@/hooks/use-database-backups';
import { DatabaseBackupsTable } from '@/components/tenant-detail/DatabaseBackupsCard';

/**
 * Tenant databases with no good backup for longer than the schedule allows,
 * across every tenant — where the "Tenant database backups overdue" alert
 * lands when it lists more than one tenant. Renders nothing when there are none.
 */
export default function OverdueDatabaseBackupsCard() {
  const { data } = useOverdueDatabaseBackups();
  const overdue = data?.data?.databases ?? [];
  if (overdue.length === 0) return null;
  return (
    <section
      className="rounded-xl border border-red-200 bg-red-50/60 dark:border-red-800 dark:bg-red-900/10"
      data-testid="overdue-database-backups-card"
    >
      <div className="px-5 pt-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-red-900 dark:text-red-200">
          <DatabaseZap size={15} aria-hidden="true" /> Database backups overdue ({overdue.length})
        </h3>
        <p className="mt-1 text-[13px] text-red-800 dark:text-red-300">
          These databases have had no good backup for longer than the tenant backup schedule allows.
          Their data files in the files snapshot are copied from the running server and are not guaranteed to restore.
        </p>
      </div>
      <div className="mt-3 overflow-x-auto">
        <DatabaseBackupsTable databases={overdue} showTenant />
      </div>
    </section>
  );
}
