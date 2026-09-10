import { useState, type FormEvent } from 'react';
import { X, Loader2, AlertCircle, AlertTriangle, ArrowRight } from 'lucide-react';
import { useUpdateDeployment } from '@/hooks/use-deployments';
import StorageFolderPicker from './StorageFolderPicker';
import { folderProblem } from '@insula/api-contracts';

/**
 * Re-point an existing deployment at a different folder on the tenant PVC.
 *
 * RE-POINT, NOT MOVE — and the wording here carries most of that weight. The
 * pod restarts with a new `subPath`; the old folder keeps its contents and is
 * simply no longer mounted, so an app pointed at an empty folder comes back
 * looking empty. That is recoverable (set the old path back) but alarming if
 * it is a surprise, which is why the confirm step spells out both halves.
 */
export default function ChangeStoragePathModal({
  tenantId,
  deploymentId,
  deploymentName,
  currentPath,
  isRunning,
  onClose,
  onChanged,
}: {
  readonly tenantId: string | undefined;
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly currentPath: string;
  readonly isRunning: boolean;
  readonly onClose: () => void;
  readonly onChanged?: () => void;
}) {
  // Start browsing where the deployment currently lives, so the common case
  // (a sibling folder) is one click away.
  const parentOfCurrent = currentPath.includes('/')
    ? currentPath.split('/').slice(0, -1).join('/')
    : '';
  const [target, setTarget] = useState<string | null>(null);
  const update = useUpdateDeployment(tenantId);

  const pathError = target ? folderProblem(target) : null;
  const unchanged = target === currentPath;
  const canSubmit = Boolean(target) && !pathError && !unchanged && !update.isPending;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !target) return;
    try {
      await update.mutateAsync({ deploymentId, storage_path: target });
      onChanged?.();
      onClose();
    } catch {
      // Surfaced via update.error below.
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="change-storage-path-modal"
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Change storage folder</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Currently serving from</span>
            <p className="font-mono text-sm text-gray-900 dark:text-gray-100" data-testid="change-storage-current">
              {currentPath}
            </p>
          </div>

          <StorageFolderPicker
            tenantId={tenantId}
            seedPath={parentOfCurrent}
            value={target}
            onChange={setTarget}
            ownDeploymentName={deploymentName}
            testIdPrefix="change-storage-picker"
          />

          {unchanged && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              That is the folder it already uses — pick a different one.
            </p>
          )}

          {target && !pathError && !unchanged && (
            <div className="space-y-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-3" data-testid="change-storage-warning">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
                <AlertTriangle size={16} className="shrink-0" />
                Your files do not move
              </div>
              <p className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-amber-900 dark:text-amber-200">
                <span>{currentPath}</span>
                <ArrowRight size={12} className="shrink-0" />
                <span>{target}</span>
              </p>
              <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-300">
                <li>
                  <span className="font-mono">{currentPath}</span> keeps everything in it.
                  Nothing is copied and nothing is deleted.
                </li>
                <li>
                  {deploymentName} will serve whatever is in{' '}
                  <span className="font-mono">{target}</span> — if that folder is
                  empty, the app will look empty.
                </li>
                <li>
                  {isRunning
                    ? 'The application restarts now to pick up the new folder.'
                    : 'The new folder takes effect the next time the application starts.'}
                </li>
                <li>Reversible: set the old folder back to return to your data.</li>
              </ul>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                To actually move content, copy it in File Manager first, then change
                the folder here.
              </p>
            </div>
          )}

          {pathError && (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <AlertCircle size={14} />
              {pathError}
            </div>
          )}

          {update.error && (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="change-storage-error">
              <AlertCircle size={14} />
              {update.error instanceof Error ? update.error.message : 'Failed to change the storage folder'}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={update.isPending}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              data-testid="change-storage-save"
            >
              {update.isPending && <Loader2 size={14} className="animate-spin" />}
              {isRunning ? 'Change folder and restart' : 'Change folder'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
