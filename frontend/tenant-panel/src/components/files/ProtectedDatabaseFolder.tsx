import { Link } from 'react-router-dom';
import { Database, FolderInput, Loader2, Lock } from 'lucide-react';
import { KEPT_DATABASES_ROOT, isUnderDatabaseRoot } from '@insula/api-contracts';
import { useDatabaseFolders, useReleaseOrphanFolders } from '@/hooks/use-deployments';
import { formatDataSize } from '@/lib/format-snapshot-size';

/**
 * Shown when the file manager enters the protected `database` folder (R48).
 * The folder reads as empty and read-only here: it holds the data of the
 * database instances, which only the platform touches while they are
 * attached. Lists the instances with their data sizes.
 */
export default function ProtectedDatabaseFolder({ tenantId, onOpenKept }: { tenantId: string | undefined; onOpenKept: () => void }) {
  const folders = useDatabaseFolders(tenantId);
  const release = useReleaseOrphanFolders(tenantId);
  const instances = folders.data?.data.instances ?? [];
  const orphans = folders.data?.data.orphans ?? [];

  return (
    <section
      data-testid="protected-database-folder"
      className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-800/60 dark:bg-amber-900/15"
    >
      <div className="flex items-start gap-3">
        <Lock size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 space-y-2 text-gray-700 dark:text-gray-300">
          <p className="font-medium text-gray-900 dark:text-gray-100">Protected folder for your database instances</p>
          <p>
            This folder holds the data of the database instances you use. Raw file access is disabled while a
            database is attached to its data, so the files here cannot be seen or changed — not in the file
            manager, and not over SFTP, rsync or scp.
          </p>
          <p>
            If you need the raw files, open the instance under Applications and choose <strong>Detach data</strong>, or
            delete the instance and keep its data. Either way the data moves to the{' '}
            <button type="button" onClick={onOpenKept} className="font-mono text-brand-600 hover:underline dark:text-brand-400">
              {KEPT_DATABASES_ROOT}
            </button>{' '}
            folder, where you can work with it. <strong>Attach data</strong> moves it back.
          </p>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-amber-200 bg-white dark:border-amber-800/60 dark:bg-gray-800">
        {folders.isLoading ? (
          <div className="flex items-center justify-center py-6"><Loader2 size={18} className="animate-spin text-gray-400" /></div>
        ) : folders.error ? (
          <p className="px-4 py-3 text-red-600 dark:text-red-400" data-testid="protected-database-folder-error">
            {folders.error instanceof Error ? folders.error.message : 'Could not load the database instances.'}
          </p>
        ) : instances.length === 0 ? (
          <p className="px-4 py-3 text-gray-500 dark:text-gray-400">No database instances.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs font-medium uppercase text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-4 py-2">Instance</th>
                <th className="px-4 py-2">State</th>
                <th className="hidden px-4 py-2 sm:table-cell">Folder</th>
                <th className="px-4 py-2 text-right">Data size</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((i) => (
                <tr key={i.deploymentId} data-testid={`protected-database-row-${i.name}`} className="border-b border-gray-100 last:border-0 dark:border-gray-700/50">
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100">
                      <Database size={14} className="text-gray-400" />
                      <Link to="/applications" className="hover:underline">{i.name}</Link>
                      <span className="text-xs font-normal text-gray-500 dark:text-gray-400">{i.catalogCode}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-600 dark:text-gray-300">{stateLabel(i.status, i.detachedPath, i.folder)}</td>
                  <td className="hidden px-4 py-2 font-mono text-xs text-gray-500 dark:text-gray-400 sm:table-cell">{i.folder}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">{formatDataSize(i.sizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {orphans.length > 0 && (
        <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800" data-testid="protected-database-orphans">
          <p className="text-gray-700 dark:text-gray-300">
            These folders belong to no database instance (left by an instance deleted earlier). Move them to{' '}
            <span className="font-mono">{KEPT_DATABASES_ROOT}</span> to see, download or delete them.
          </p>
          <ul className="mt-2 space-y-1">
            {orphans.map((o) => (
              <li key={o.folder} className="flex justify-between gap-4 font-mono text-xs text-gray-600 dark:text-gray-400">
                <span className="truncate">{o.folder}</span>
                <span className="shrink-0 tabular-nums">{formatDataSize(o.sizeBytes)}</span>
              </li>
            ))}
          </ul>
          {release.error && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">{release.error instanceof Error ? release.error.message : 'The folders could not be moved.'}</p>
          )}
          <button
            type="button"
            onClick={() => release.mutate()}
            disabled={release.isPending}
            data-testid="release-orphan-folders"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700/50"
          >
            {release.isPending ? <Loader2 size={14} className="animate-spin" /> : <FolderInput size={14} />}
            Move to {KEPT_DATABASES_ROOT}
          </button>
        </div>
      )}
    </section>
  );
}

function stateLabel(status: string, detachedPath: string | null, folder: string): string {
  if (detachedPath) return 'Data detached';
  // Its folder is shared with another application, so it has not been moved
  // into the protected folder yet (the operator is told).
  if (!isUnderDatabaseRoot(folder)) return 'Not protected yet (folder shared)';
  if (status === 'deleted') return 'Recently deleted';
  if (status === 'stopped') return 'Stopped';
  if (status === 'running') return 'Attached, running';
  return 'Attached';
}
