import { useState, useMemo } from 'react';
import { Loader2, RotateCcw, Trash2, AlertTriangle, FolderOpen, File as FileIcon, Link2 } from 'lucide-react';
import type { TrashEntry } from '@insula/api-contracts';
import { useTrash, useRestoreFromTrash, usePurgeTrash, daysUntilPurge } from '@/hooks/use-trash';

/**
 * Recycle bin view.
 *
 * Lives here rather than in Files.tsx, which is already past 2000 lines.
 */

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function EntryIcon({ type }: { readonly type: TrashEntry['type'] }) {
  if (type === 'directory') return <FolderOpen size={16} className="shrink-0 text-amber-500" />;
  if (type === 'symlink') return <Link2 size={16} className="shrink-0 text-gray-400" />;
  return <FileIcon size={16} className="shrink-0 text-gray-400 dark:text-gray-500" />;
}

export default function TrashPanel({ onRestored }: { readonly onRestored?: () => void }) {
  const { data, isLoading, isError, error } = useTrash();
  const restore = useRestoreFromTrash();
  const purge = usePurgeTrash();

  const [conflict, setConflict] = useState<{ id: string; path: string } | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<TrashEntry | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Bulk selection. Restoring 50 accidentally-deleted files one row at a time
  // is the difference between a usable bin and a demo.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [query, setQuery] = useState('');

  const allEntries = data?.entries ?? [];
  const retentionDays = data?.retentionDays ?? 14;
  // Filtering matters once a single archive extraction can add dozens of
  // entries in one go.
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allEntries;
    return allEntries.filter(e =>
      e.name.toLowerCase().includes(q) || (e.originalPath ?? '').toLowerCase().includes(q));
  }, [allEntries, query]);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allShownSelected = entries.length > 0 && entries.every(e => selected.has(e.id));
  const selectedIds = entries.filter(e => selected.has(e.id)).map(e => e.id);

  const bulkRestore = () => {
    setBulkBusy(true);
    let done = 0;
    selectedIds.forEach((id) => {
      // autoRename: a bulk restore must never clobber whatever occupies the
      // path now — that would be a second destruction dressed as a recovery.
      restore.mutate({ id, autoRename: true }, {
        onSettled: () => {
          done += 1;
          if (done === selectedIds.length) { setBulkBusy(false); setSelected(new Set()); onRestored?.(); }
        },
      });
    });
  };

  const handleRestore = (entry: TrashEntry, opts?: { overwrite?: boolean; autoRename?: boolean }) => {
    setBusyId(entry.id);
    restore.mutate({ id: entry.id, ...opts }, {
      onSuccess: () => { setBusyId(null); setConflict(null); onRestored?.(); },
      onError: (err) => {
        setBusyId(null);
        // A 409 is an expected outcome, not a failure: offer the two ways out
        // instead of dead-ending on a red banner.
        const conflictPath = (err as { details?: { conflictPath?: string } })?.details?.conflictPath;
        if (conflictPath) setConflict({ id: entry.id, path: conflictPath });
      },
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8" data-testid="trash-loading">
        <Loader2 size={18} className="animate-spin text-brand-500" />
        <span className="text-sm text-gray-500 dark:text-gray-400">Loading recycle bin…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
        <AlertTriangle size={16} />
        <span>Could not load the recycle bin: {error instanceof Error ? error.message : 'Unknown error'}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="trash-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
        <div className="text-sm text-gray-700 dark:text-gray-300">
          <strong>{entries.length}</strong> item{entries.length === 1 ? '' : 's'} · <strong>{data?.usedFormatted ?? '0 B'}</strong>
          {/* The whole point of having no size cap: say plainly what it costs. */}
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            Trashed files still count toward your storage. Items are removed automatically after {retentionDays} day{retentionDays === 1 ? '' : 's'}.
          </span>
        </div>
        <button
          onClick={() => setConfirmEmpty(true)}
          disabled={entries.length === 0 || purge.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/30"
          data-testid="empty-trash-button"
        >
          {purge.isPending && <Loader2 size={14} className="animate-spin" />}
          <Trash2 size={14} /> Empty recycle bin
        </button>
      </div>

      {allEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name or original location…"
            className="min-w-[220px] flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid="trash-filter"
          />
          {selectedIds.length > 0 && (
            <>
              <span className="text-sm text-gray-600 dark:text-gray-400">{selectedIds.length} selected</span>
              <button
                onClick={bulkRestore}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 px-3 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-400 dark:hover:bg-brand-900/30"
                data-testid="bulk-restore"
              >
                {bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} Restore selected
              </button>
              <button
                onClick={() => purge.mutate({ ids: selectedIds }, { onSuccess: () => setSelected(new Set()) })}
                disabled={purge.isPending || bulkBusy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/30"
                data-testid="bulk-purge"
              >
                <Trash2 size={14} /> Delete selected
              </button>
            </>
          )}
        </div>
      )}

      {entries.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="trash-empty">
          {allEntries.length === 0 ? 'The recycle bin is empty.' : 'No entries match that filter.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="py-2 pr-2 font-medium">
                  <input
                    type="checkbox"
                    checked={allShownSelected}
                    onChange={() => setSelected(allShownSelected ? new Set() : new Set(entries.map(e => e.id)))}
                    aria-label="Select all shown"
                    className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-700"
                    data-testid="trash-select-all"
                  />
                </th>
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Original location</th>
                <th className="py-2 pr-3 font-medium">Size</th>
                <th className="py-2 pr-3 font-medium">Deleted</th>
                <th className="py-2 pr-3 font-medium">Removed in</th>
                <th className="py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const days = daysUntilPurge(entry.deletedAt, retentionDays);
                const busy = busyId === entry.id;
                return (
                  <tr key={entry.id} className="border-b border-gray-100 last:border-0 dark:border-gray-800" data-testid={`trash-row-${entry.id}`}>
                    <td className="py-2 pr-2 align-top">
                      <input
                        type="checkbox"
                        checked={selected.has(entry.id)}
                        onChange={() => toggle(entry.id)}
                        aria-label={`Select ${entry.name}`}
                        className="mt-1 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-700"
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <EntryIcon type={entry.type} />
                        <span className="truncate font-medium text-gray-900 dark:text-gray-100">{entry.name}</span>
                      </div>
                      {entry.deploymentName && (
                        <span className="ml-6 text-xs text-gray-500 dark:text-gray-400">
                          data folder of deployment “{entry.deploymentName}” — restoring returns the files only, not the deployment
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">
                      {entry.originalPath ? (
                        <code className="rounded bg-gray-100 px-1 py-0.5 text-xs dark:bg-gray-700">/{entry.originalPath}</code>
                      ) : (
                        <span className="text-xs italic text-amber-600 dark:text-amber-400" title="Details for this item were lost; it will be restored to /restored/">
                          unknown
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{formatBytes(entry.sizeBytes)}</td>
                    <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{new Date(entry.deletedAt).toLocaleString()}</td>
                    <td className="py-2 pr-3">
                      <span className={days <= 1 ? 'font-medium text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}>
                        {days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`}
                      </span>
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => handleRestore(entry)}
                        disabled={busy}
                        className="mr-1 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:text-brand-400 dark:hover:bg-brand-900/30"
                        data-testid={`restore-${entry.id}`}
                      >
                        {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Restore
                      </button>
                      <button
                        onClick={() => setPurgeTarget(entry)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/30"
                        data-testid={`purge-${entry.id}`}
                      >
                        <Trash2 size={12} /> Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {conflict && (
        <Modal title="Something is already there" onClose={() => setConflict(null)}>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            <code className="rounded bg-gray-100 px-1 py-0.5 text-xs dark:bg-gray-700">/{conflict.path}</code> already
            exists. Restoring alongside keeps both; replacing discards the file that is there now.
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button onClick={() => setConflict(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
            <button
              onClick={() => { const e = entries.find(x => x.id === conflict.id); if (e) handleRestore(e, { autoRename: true }); }}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
              data-testid="restore-alongside"
            >
              Restore alongside
            </button>
            <button
              onClick={() => { const e = entries.find(x => x.id === conflict.id); if (e) handleRestore(e, { overwrite: true }); }}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              data-testid="restore-overwrite"
            >
              Replace existing
            </button>
          </div>
        </Modal>
      )}

      {purgeTarget && (
        <Modal title="Delete permanently" onClose={() => setPurgeTarget(null)}>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Permanently delete <strong className="text-gray-900 dark:text-gray-100">{purgeTarget.name}</strong>?
          </p>
          <p className="mt-3 flex items-start gap-1.5 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
            <AlertTriangle size={14} className="mt-px shrink-0" />
            <span>This cannot be undone.</span>
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setPurgeTarget(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
            <button
              onClick={() => purge.mutate({ ids: [purgeTarget.id] }, { onSuccess: () => setPurgeTarget(null) })}
              disabled={purge.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              data-testid="confirm-purge-one"
            >
              {purge.isPending && <Loader2 size={14} className="animate-spin" />} Delete permanently
            </button>
          </div>
        </Modal>
      )}

      {confirmEmpty && (
        <Modal title="Empty recycle bin" onClose={() => setConfirmEmpty(false)}>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Permanently delete all <strong className="text-gray-900 dark:text-gray-100">{entries.length}</strong> item
            {entries.length === 1 ? '' : 's'} ({data?.usedFormatted})? This frees the space immediately.
          </p>
          <p className="mt-3 flex items-start gap-1.5 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
            <AlertTriangle size={14} className="mt-px shrink-0" />
            <span>This cannot be undone.</span>
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setConfirmEmpty(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
            <button
              onClick={() => purge.mutate({ all: true }, { onSuccess: () => setConfirmEmpty(false) })}
              disabled={purge.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              data-testid="confirm-empty-trash"
            >
              {purge.isPending && <Loader2 size={14} className="animate-spin" />} Empty recycle bin
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: {
  readonly title: string; readonly onClose: () => void; readonly children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        {children}
      </div>
    </div>
  );
}
