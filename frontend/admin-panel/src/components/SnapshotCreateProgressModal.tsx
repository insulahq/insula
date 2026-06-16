/**
 * Snapshot-create progress modal (task-center driven).
 *
 * Opened inline right after "Take snapshot" AND re-openable from the
 * task-center chip (registered under the `snapshot-create` modal key).
 * Tracks the `storage.snapshot` task the backend enrolls for each create:
 * running → succeeded (ready, with size) / failed (with error).
 *
 * The chip passes `{ taskId, taskStatus, taskDetails, taskFinishedAt }`
 * plus our `modalProps` ({ snapshotId, tenantId }). When opened inline we
 * only have `snapshotId`, so we resolve the task by refId/details too.
 */

import { useMemo } from 'react';
import { Camera, Loader2, CheckCircle, AlertTriangle, X } from 'lucide-react';
import { useTaskCenter } from '@/hooks/use-task-center';
import type { TaskRow, TaskStatus } from '@insula/api-contracts';

function formatBytes(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

interface Props {
  readonly onClose: () => void;
  readonly taskId?: string;
  readonly snapshotId?: string;
  readonly tenantId?: string;
  // Fallbacks the chip supplies for tasks already cleared from the live feed.
  readonly taskStatus?: TaskStatus;
}

export default function SnapshotCreateProgressModal({ onClose, taskId, snapshotId, taskStatus }: Props) {
  const { data } = useTaskCenter();
  const task: TaskRow | undefined = useMemo(() => {
    const tasks = data?.data?.tasks ?? [];
    if (taskId) return tasks.find((t) => t.id === taskId);
    if (snapshotId) return tasks.find((t) => t.refId === snapshotId || t.details?.snapshotId === snapshotId);
    return undefined;
  }, [data, taskId, snapshotId]);

  const status: TaskStatus = task?.status ?? taskStatus ?? 'running';
  const running = status === 'running' || status === 'queued';
  const failed = status === 'failed' || status === 'cancelled';
  const succeeded = status === 'succeeded';
  const sizeBytes = typeof task?.details?.sizeBytes === 'number' ? task.details.sizeBytes : 0;
  const progressText = task?.progressText ?? (running ? 'Creating snapshot…' : '');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <Camera size={18} className="text-indigo-500" /> Taking snapshot
          </h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {running && (
            <>
              <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300" data-testid="snap-create-running">
                <Loader2 size={16} className="animate-spin text-indigo-500" />
                <span>{progressText}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <div className="h-full animate-pulse rounded-full bg-indigo-500" style={{ width: `${task?.progressPct ?? 40}%` }} />
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                On-server Longhorn snapshot — usually ready in a few seconds. It's safe to close this; progress stays in the task center.
              </p>
            </>
          )}

          {succeeded && (
            <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400" data-testid="snap-create-done">
              <CheckCircle size={18} /> Snapshot ready{sizeBytes ? ` — ${formatBytes(sizeBytes)}` : ''}.
            </div>
          )}

          {failed && (
            <div className="flex items-start gap-2 text-sm text-red-700 dark:text-red-400" data-testid="snap-create-failed">
              <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
              <span>Snapshot failed: {task?.errorMessage || 'unknown error'}.</span>
            </div>
          )}

          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700" data-testid="snap-create-close">
              {running ? 'Run in background' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
