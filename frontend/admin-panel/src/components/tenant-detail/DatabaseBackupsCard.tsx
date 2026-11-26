/**
 * Tenant → Storage & backups → Database backups: each of the tenant's
 * databases, its last good backup and why the last attempt was not one.
 *
 * A bundle can be `completed` while every database in it failed to dump — the
 * bundle list above cannot show that. This card is where it shows.
 */
import { Loader2 } from 'lucide-react';
import type { AdminDatabaseBackupStatus } from '@insula/api-contracts';
import TimeCell from '@/components/ui/TimeCell';
import { formatBytes } from '@/lib/format-bytes';
import { useTenantDatabaseBackups } from '@/hooks/use-database-backups';
import { Card, Chip, type Tone } from './ui';

const STATUS: Readonly<Record<AdminDatabaseBackupStatus['lastStatus'], { label: string; tone: Tone }>> = {
  dumped: { label: 'Backed up', tone: 'ok' },
  degraded: { label: 'Skipped', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
};

export function DatabaseBackupsTable({ databases, showTenant = false }: {
  readonly databases: readonly AdminDatabaseBackupStatus[];
  readonly showTenant?: boolean;
}) {
  return (
    <table className="w-full text-left text-[13px]" data-testid="database-backups-table">
      <thead>
        <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {showTenant && <th className="px-5 py-2.5 font-medium">Tenant</th>}
          <th className="px-5 py-2.5 font-medium">Database</th>
          <th className="px-5 py-2.5 font-medium">Instance</th>
          <th className="px-5 py-2.5 font-medium">Last good backup</th>
          <th className="px-5 py-2.5 font-medium">Last attempt</th>
        </tr>
      </thead>
      <tbody>
        {databases.map((d) => {
          const s = STATUS[d.lastStatus];
          return (
            <tr
              key={`${d.tenantId}|${d.subjectKey}|${d.databaseName}`}
              className="border-b border-gray-100 align-top last:border-0 dark:border-gray-700"
              data-testid="database-backup-row"
            >
              {showTenant && <td className="px-5 py-3 text-gray-700 dark:text-gray-300">{d.tenantName}</td>}
              <td className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-medium text-gray-900 dark:text-gray-100">{d.databaseLabel}</span>
                  {d.overdue && (
                    <Chip tone="bad" testId="database-backup-overdue" title={d.overdueSince ? `Overdue since ${new Date(d.overdueSince).toLocaleString()}` : undefined}>
                      Overdue
                    </Chip>
                  )}
                </div>
              </td>
              <td className="px-5 py-3 text-gray-700 dark:text-gray-300">{d.instanceLabel}</td>
              <td className="px-5 py-3 text-gray-700 dark:text-gray-300">
                {d.lastSuccessAt ? (
                  <>
                    <TimeCell iso={d.lastSuccessAt} />
                    {d.lastSuccessSizeBytes != null && (
                      <span className="ml-1 text-gray-500 dark:text-gray-400">({formatBytes(d.lastSuccessSizeBytes)})</span>
                    )}
                  </>
                ) : (
                  <span className="text-red-600 dark:text-red-400">Never</span>
                )}
              </td>
              <td className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={s.tone}>{s.label}</Chip>
                  <span className="text-gray-500 dark:text-gray-400"><TimeCell iso={d.lastAttemptAt} /></span>
                </div>
                {d.lastError && (
                  <p className="mt-1 max-w-xl break-words text-xs text-gray-600 dark:text-gray-400" data-testid="database-backup-error">
                    {d.lastError}
                  </p>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function DatabaseBackupsCard({ tenantId }: { readonly tenantId: string }) {
  const q = useTenantDatabaseBackups(tenantId);
  const databases = q.data?.data?.databases ?? [];
  const overdue = databases.filter((d) => d.overdue).length;
  return (
    <Card
      title={(
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Database backups</h2>
          <span className="text-[13px] text-gray-500 dark:text-gray-400">
            Each database&apos;s dump is its backup; its data files in the snapshot are copied from the running server
          </span>
        </div>
      )}
      actions={overdue > 0 ? <Chip tone="bad" testId="database-backups-overdue-count">{overdue} overdue</Chip> : undefined}
      bodyClassName="overflow-x-auto"
      testId="tenant-database-backups"
    >
      {q.isLoading ? (
        <div className="flex items-center gap-2 px-5 py-4 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : q.error ? (
        <p className="px-5 py-4 text-sm text-red-600 dark:text-red-400">Failed to load database backups.</p>
      ) : databases.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-600 dark:text-gray-400">
          No databases recorded yet. Databases appear here after the next backup of this tenant.
        </p>
      ) : (
        <DatabaseBackupsTable databases={databases} />
      )}
    </Card>
  );
}
