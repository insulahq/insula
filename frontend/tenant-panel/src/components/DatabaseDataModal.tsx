import { useState, type FormEvent } from 'react';
import { X, Loader2, AlertCircle, AlertTriangle } from 'lucide-react';
import { KEPT_DATABASES_ROOT, folderProblem } from '@insula/api-contracts';
import { useAttachDatabaseData, useDetachDatabaseData } from '@/hooks/use-deployments';
import StorageFolderPicker from './StorageFolderPicker';

/**
 * Detach or attach a standalone database instance's data (R48).
 *
 * Attached, the data sits in the protected `database` folder, which the file
 * manager and SFTP cannot reach. Detach stops the instance and moves its data
 * to `kept-databases/<name>` for raw access; Attach moves a folder back in
 * and starts the instance, which takes the platform's administrator login
 * back on that start.
 */
export default function DatabaseDataModal({
  tenantId,
  deploymentId,
  deploymentName,
  detachedPath,
  onClose,
}: {
  readonly tenantId: string | undefined;
  readonly deploymentId: string;
  readonly deploymentName: string;
  /** Set while the data is detached: the attach dialog starts from it. */
  readonly detachedPath: string | null;
  readonly onClose: () => void;
}) {
  const mode = detachedPath ? 'attach' : 'detach';
  const [target, setTarget] = useState<string | null>(detachedPath);
  const detach = useDetachDatabaseData(tenantId);
  const attach = useAttachDatabaseData(tenantId);
  const pending = detach.isPending || attach.isPending;
  const error = detach.error ?? attach.error;
  const pathError = mode === 'attach' && target ? folderProblem(target) : null;
  const canSubmit = !pending && (mode === 'detach' || (Boolean(target) && !pathError));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      if (mode === 'detach') await detach.mutateAsync(deploymentId);
      else await attach.mutateAsync({ deploymentId, path: target ?? undefined });
      onClose();
    } catch {
      // Shown below from the mutation's error.
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={pending ? undefined : onClose} data-testid="database-data-modal">
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {mode === 'detach' ? `Detach the data of ${deploymentName}` : `Attach data to ${deploymentName}`}
          </h2>
          <button type="button" onClick={onClose} disabled={pending} aria-label="Close"
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 dark:hover:bg-gray-700 dark:hover:text-gray-200">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'detach' ? (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300" data-testid="database-detach-explainer">
              <div className="flex items-center gap-2 font-medium"><AlertTriangle size={16} className="shrink-0" /> The database stops</div>
              <ul className="list-disc space-y-1 pl-5 text-xs">
                <li>{deploymentName} stops, and its data moves to <span className="font-mono">/{KEPT_DATABASES_ROOT}/{deploymentName}</span>, where the file manager and SFTP can reach the raw files.</li>
                <li>It stays stopped until you attach data again — this folder or another one.</li>
                <li>Raw files are not a backup. Your nightly database backups keep running for the other instances.</li>
              </ul>
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Choose the folder with the database's data. It moves into the protected database folder, and {deploymentName} starts
                on it. The platform takes its administrator login back on that start.
              </p>
              <StorageFolderPicker
                tenantId={tenantId}
                seedPath={KEPT_DATABASES_ROOT}
                value={target}
                onChange={setTarget}
                ownDeploymentName={deploymentName}
                testIdPrefix="attach-data-picker"
              />
              {pathError && (
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"><AlertCircle size={14} />{pathError}</div>
              )}
            </>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="database-data-error">
              <AlertCircle size={14} className="shrink-0" />
              {error instanceof Error ? error.message : 'The data could not be moved.'}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={pending}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700/50">
              Cancel
            </button>
            <button type="submit" disabled={!canSubmit} data-testid="database-data-submit"
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50">
              {pending && <Loader2 size={14} className="animate-spin" />}
              {mode === 'detach' ? 'Stop and detach data' : 'Attach and start'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
