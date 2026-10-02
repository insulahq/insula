import { Check, X } from 'lucide-react';
import type { UploadChunkProgress, UploadProgress } from '@/hooks/use-file-manager';

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

export default function UploadProgressModal({ uploads, onClose }: { readonly uploads: readonly UploadProgress[]; readonly onClose: () => void }) {
  const allDone = uploads.every(u => u.status === 'done' || u.status === 'error' || u.status === 'cancelled');
  const totalFiles = uploads.length;
  const completedFiles = uploads.filter(u => u.status === 'done').length;
  const failedFiles = uploads.filter(u => u.status === 'error').length;
  const cancelledFiles = uploads.filter(u => u.status === 'cancelled').length;

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
          </div>
        )}

        <div className="space-y-2 max-h-72 overflow-y-auto">
          {uploads.map((u, i) => (
            <div key={i} className={`rounded-lg border p-2 ${u.status === 'cancelled' ? 'border-gray-200 dark:border-gray-600 opacity-60' : 'border-gray-100 dark:border-gray-700'}`}>
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
            </div>
          ))}
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
