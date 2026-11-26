/**
 * Backups → Database backups: each of the tenant's databases, when it was last
 * backed up and, when the last attempt failed, why.
 *
 * A bundle can finish while one of its database dumps failed; the bundle list
 * cannot show that per database. Renders nothing for a tenant with no
 * databases recorded.
 */
import { Database, Loader2 } from 'lucide-react';
import type { DatabaseBackupStatus } from '@insula/api-contracts';
import { useTenantDatabaseBackups } from '@/hooks/use-tenant-backups';
import TimeCell from '@/components/ui/TimeCell';

const STATUS: Readonly<Record<DatabaseBackupStatus['lastStatus'], { label: string; cls: string }>> = {
  dumped: { label: 'Backed up', cls: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700' },
  degraded: { label: 'Skipped', cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700' },
  failed: { label: 'Failed', cls: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700' },
};

export default function DatabaseBackupsCard() {
  const q = useTenantDatabaseBackups();
  const databases = q.data?.data?.databases ?? [];
  if (!q.isLoading && !q.isError && databases.length === 0) return null;
  const overdue = databases.filter((d) => d.overdue).length;
  return (
    <div
      className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
      data-testid="tenant-database-backups"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-6 py-4 dark:border-gray-700">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Database className="h-4 w-4" /> Database backups
        </h2>
        {overdue > 0 && (
          <span
            className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:border-red-700 dark:bg-red-900/40 dark:text-red-300"
            data-testid="tenant-database-backups-overdue"
          >
            {overdue} overdue
          </span>
        )}
      </div>
      {q.isLoading ? (
        <div className="flex items-center gap-2 px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : q.isError ? (
        <p className="px-6 py-4 text-sm text-red-600 dark:text-red-400">Failed to load database backups.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="tenant-database-backups-table">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50/50 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-400">
                <th className="px-6 py-3 font-medium">Database</th>
                <th className="px-6 py-3 font-medium">Instance</th>
                <th className="px-6 py-3 font-medium">Last good backup</th>
                <th className="px-6 py-3 font-medium">Last attempt</th>
              </tr>
            </thead>
            <tbody>
              {databases.map((d) => {
                const s = STATUS[d.lastStatus];
                return (
                  <tr
                    key={`${d.subjectKey}|${d.databaseName}`}
                    className="border-b border-gray-100 align-top last:border-0 dark:border-gray-700"
                    data-testid="tenant-database-backup-row"
                  >
                    <td className="px-6 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-medium text-gray-900 dark:text-gray-100">{d.databaseLabel}</span>
                        {d.overdue && (
                          <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:border-red-700 dark:bg-red-900/40 dark:text-red-300">
                            Overdue
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-gray-600 dark:text-gray-400">{d.instanceLabel}</td>
                    <td className="px-6 py-3 text-gray-600 dark:text-gray-400">
                      {d.lastSuccessAt ? <TimeCell iso={d.lastSuccessAt} /> : <span className="text-red-600 dark:text-red-400">Never</span>}
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
                        <span className="text-xs text-gray-500 dark:text-gray-400"><TimeCell iso={d.lastAttemptAt} /></span>
                      </div>
                      {d.lastError && (
                        <p className="mt-1 max-w-xl break-words text-xs text-gray-600 dark:text-gray-400" data-testid="tenant-database-backup-error">
                          {d.lastError}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
