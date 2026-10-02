import { Check, X } from 'lucide-react';
import type { UploadChunkProgress, UploadProgress } from '@/hooks/use-file-manager';
import {
  averageSpeed, formatBytes, formatDuration, formatSpeed, liveSpeedLabel, summarizeUploads, type UploadSummary,
} from '@/lib/upload-speed';

/**
 * Progress for file-manager uploads.
 *
 * Each file shows bytes sent of its total and its current speed while it
 * runs, then its final size, duration and average speed once it lands; with
 * several files an overall line adds them up. The modal only closes when the
 * user closes it, so the final numbers stay readable.
 *
 * A failed or cancelled upload shows no size or speed at all: nothing it sent
 * is on disk, and its last speed is not a speed anything is moving at.
 */

/** Multi-chunk progress bar. Renders one segment per chunk; each
 *  segment fills proportional to its own loaded/size ratio so the
 *  user sees parallel chunks racing in real time. Done chunks are
 *  fully filled green; the in-flight chunks have a lighter fill. */
function ChunkedProgressBar({ chunks }: { readonly chunks: readonly UploadChunkProgress[] }) {
  const total = chunks.reduce((acc, c) => acc + c.size, 0);
  return (
    <div className="mt-1 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-gray-200 dark:bg-gray-600">
      {chunks.map((c) => {
        const widthPct = total === 0 ? 0 : (c.size / total) * 100;
        const fillPct = c.size === 0 ? 0 : Math.min(100, (c.loaded / c.size) * 100);
        const fillClass =
          c.status === 'done'
            ? 'bg-green-500'
            : c.status === 'error'
            ? 'bg-red-500'
            : c.status === 'uploading'
            ? 'bg-green-400'
            : 'bg-gray-300 dark:bg-gray-500';
        return (
          <div key={c.idx} className="relative h-full" style={{ width: `${widthPct}%` }}>
            <div className={`absolute inset-y-0 left-0 ${fillClass} transition-all`} style={{ width: `${fillPct}%` }} />
          </div>
        );
      })}
    </div>
  );
}

/** What an upload moved (left) and how fast (right); a side with nothing true
 *  to say stays empty. */
function TransferLine({ left, right, testId }: { readonly left: string; readonly right: string | null; readonly testId: string }) {
  return (
    <div className="mt-1 flex items-center justify-between gap-3 text-xs tabular-nums text-gray-500 dark:text-gray-400" data-testid={testId}>
      <span className="min-w-0 truncate">{left}</span>
      {right !== null && <span className="shrink-0 whitespace-nowrap">{right}</span>}
    </div>
  );
}

function transferOf(u: UploadProgress): { readonly left: string; readonly right: string | null } | null {
  if (u.status === 'uploading') {
    return {
      left: `${formatBytes(u.loaded)} of ${formatBytes(u.total)}`,
      right: liveSpeedLabel(u.loaded, u.total, u.speed),
    };
  }
  if (u.status === 'done') {
    const elapsed = u.finishedAt === undefined ? null : u.finishedAt - u.startedAt;
    const avg = elapsed === null ? null : averageSpeed(u.total, elapsed);
    return {
      left: elapsed === null ? formatBytes(u.total) : `${formatBytes(u.total)} in ${formatDuration(elapsed)}`,
      right: avg === null ? null : `avg ${formatSpeed(avg)}`,
    };
  }
  return null;
}

function OverallProgress({ summary, fileCount }: { readonly summary: UploadSummary; readonly fileCount: number }) {
  return (
    <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/40" data-testid="upload-overall">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-gray-700 dark:text-gray-300">
          Overall · {summary.doneCount} of {fileCount} files done
        </span>
        <span className="text-xs font-semibold text-brand-600 dark:text-brand-400">{summary.percent}%</span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-600"
        role="progressbar"
        aria-label="Overall upload progress"
        aria-valuenow={summary.percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-1.5 rounded-full bg-brand-500 transition-all dark:bg-brand-400" style={{ width: `${summary.percent}%` }} />
      </div>
      <TransferLine
        testId="upload-overall-transfer"
        left={`${formatBytes(summary.loaded)} of ${formatBytes(summary.total)}`}
        right={liveSpeedLabel(summary.loaded, summary.total, summary.speed)}
      />
    </div>
  );
}

export default function UploadProgressModal({ uploads, onClose }: { readonly uploads: readonly UploadProgress[]; readonly onClose: () => void }) {
  const allDone = uploads.every(u => u.status === 'done' || u.status === 'error' || u.status === 'cancelled');
  const totalFiles = uploads.length;
  const completedFiles = uploads.filter(u => u.status === 'done').length;
  const failedFiles = uploads.filter(u => u.status === 'error').length;
  const cancelledFiles = uploads.filter(u => u.status === 'cancelled').length;
  const summary = totalFiles > 1 ? summarizeUploads(uploads) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget && allDone) onClose(); }}>
      <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {allDone ? 'Upload Complete' : 'Uploading Files'}
          </h3>
          {allDone && <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={16} /></button>}
        </div>

        {allDone && (
          <div className="text-center py-2 mb-3">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
              <Check size={20} className="text-green-600 dark:text-green-400" />
            </div>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {completedFiles} of {totalFiles} file{totalFiles > 1 ? 's' : ''} uploaded
              {failedFiles > 0 && <span className="text-red-500"> ({failedFiles} failed)</span>}
              {cancelledFiles > 0 && <span className="text-gray-400"> ({cancelledFiles} cancelled)</span>}
            </p>
            {summary && summary.doneCount > 0 && (
              <p className="mt-1 text-xs tabular-nums text-gray-500 dark:text-gray-400" data-testid="upload-overall">
                {formatBytes(summary.doneBytes)}
                {summary.doneElapsedMs !== null && ` in ${formatDuration(summary.doneElapsedMs)}`}
                {summary.doneAverageSpeed !== null && ` · avg ${formatSpeed(summary.doneAverageSpeed)}`}
              </p>
            )}
          </div>
        )}

        {!allDone && summary && <OverallProgress summary={summary} fileCount={totalFiles} />}

        <div className="space-y-2 max-h-72 overflow-y-auto">
          {uploads.map((u, i) => {
            const transfer = transferOf(u);
            return (
              <div key={i} data-testid="upload-row" className={`rounded-lg border p-2 ${u.status === 'cancelled' ? 'border-gray-200 dark:border-gray-600 opacity-60' : 'border-gray-100 dark:border-gray-700'}`}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span
                    title={u.filename}
                    className={`min-w-0 flex-1 truncate ${u.status === 'cancelled' ? 'text-gray-400 dark:text-gray-500 line-through' : 'text-gray-700 dark:text-gray-300'}`}
                  >
                    {u.filename}
                  </span>
                  <span className="flex items-center gap-2 text-xs shrink-0 whitespace-nowrap">
                    {u.chunks && u.chunks.length > 1 && u.status === 'uploading' && (
                      <span className="text-gray-500 dark:text-gray-400">{u.chunks.filter(c => c.status === 'done').length}/{u.chunks.length} chunks</span>
                    )}
                    {u.status === 'done' && <span className="font-semibold text-green-600 dark:text-green-400">Done</span>}
                    {u.status === 'error' && <span className="text-red-500">{u.error}</span>}
                    {u.status === 'cancelled' && <span className="text-gray-400">Cancelled</span>}
                    {u.status === 'uploading' && (
                      <>
                        <span className="font-semibold text-green-600 dark:text-green-400">{u.percent}%</span>
                        {u.abort && (
                          <button
                            onClick={() => u.abort?.()}
                            className="rounded p-1 text-gray-400 hover:text-red-500 transition-colors"
                            title="Cancel upload"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </div>
                {u.status === 'uploading' && (
                  u.chunks && u.chunks.length > 1 ? (
                    <ChunkedProgressBar chunks={u.chunks} />
                  ) : (
                    <div className="mt-1 h-1.5 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
                      <div className="h-1.5 rounded-full bg-green-500 transition-all" style={{ width: `${u.percent}%` }} />
                    </div>
                  )
                )}
                {u.status === 'done' && (
                  <div className="mt-1 h-1.5 rounded-full bg-green-500" />
                )}
                {u.status === 'cancelled' && (
                  <div className="mt-1 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600" />
                )}
                {transfer && <TransferLine testId="upload-transfer" left={transfer.left} right={transfer.right} />}
              </div>
            );
          })}
        </div>

        {allDone && (
          <div className="mt-4 flex justify-end">
            <button onClick={onClose} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600">Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
