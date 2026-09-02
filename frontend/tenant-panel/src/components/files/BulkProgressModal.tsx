import { useEffect } from 'react';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { BulkRunState } from '@/hooks/use-bulk-operation';

/**
 * Progress for any bulk file operation — move, copy, delete, chmod, chown.
 *
 * Before this, a bulk operation was a spinner on a button: no count, no
 * current file, and on a partial failure the dialog either closed as if
 * everything had worked or showed a single error for a batch that had mostly
 * succeeded.
 *
 * Three terminal states, deliberately distinct:
 *   - every path succeeded  → auto-closes (nothing left to tell the user)
 *   - some paths failed     → STAYS OPEN listing exactly which, and why
 *   - the operation itself failed → stays open with the error
 *
 * Auto-close is the reason the success path holds at 100% for a beat first:
 * a modal that vanishes the instant the last file lands reads as a glitch
 * rather than a completion.
 */

const AUTO_CLOSE_MS = 600;

interface BulkProgressModalProps {
  readonly state: BulkRunState;
  readonly onClose: () => void;
}

export default function BulkProgressModal({ state, onClose }: BulkProgressModalProps) {
  const { phase, label, total, progress, result, error } = state;
  const cleanSweep = phase === 'done' && (result?.failed.length ?? 0) === 0;

  useEffect(() => {
    if (!cleanSweep) return;
    const id = setTimeout(onClose, AUTO_CLOSE_MS);
    return () => clearTimeout(id);
  }, [cleanSweep, onClose]);

  if (phase === 'idle') return null;

  const done = progress?.done ?? (phase === 'done' ? total : 0);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const failed = result?.failed ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid="bulk-progress-modal"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <div className="flex items-center gap-2">
          {phase === 'running' && <Loader2 size={18} className="animate-spin text-brand-500" />}
          {cleanSweep && <CheckCircle2 size={18} className="text-green-600 dark:text-green-400" />}
          {(phase === 'failed' || failed.length > 0) && (
            <AlertTriangle size={18} className="text-red-600 dark:text-red-400" />
          )}
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{label}</h3>
        </div>

        {phase !== 'failed' && (
          <>
            <div
              className="mt-4 h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-brand-500 transition-all duration-150 dark:bg-brand-400"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400" data-testid="bulk-progress-count">
              {done} of {total} · {percent}%
            </p>
            {phase === 'running' && progress?.current && (
              // `dir="rtl"` keeps the END of a long path visible — the filename
              // is what identifies it, not the leading directories.
              <p className="mt-1 truncate text-left text-xs text-gray-500 dark:text-gray-500" dir="rtl">
                {progress.current}
              </p>
            )}
          </>
        )}

        {phase === 'failed' && error && (
          <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 dark:border-red-700 dark:bg-red-900/30">
            <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
          </div>
        )}

        {failed.length > 0 && (
          <div
            className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 dark:border-red-700 dark:bg-red-900/30"
            data-testid="bulk-progress-failures"
          >
            <p className="text-sm font-medium text-red-800 dark:text-red-300">
              {result?.succeeded.length ?? 0} succeeded, {failed.length} failed
            </p>
            <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-red-700 dark:text-red-400">
              {failed.map(f => (
                <li key={f.path} className="truncate">{f.path} — {f.error}</li>
              ))}
            </ul>
          </div>
        )}

        {phase !== 'running' && !cleanSweep && (
          <div className="mt-4 flex justify-end">
            <button
              onClick={onClose}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
