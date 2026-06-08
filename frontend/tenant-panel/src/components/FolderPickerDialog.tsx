import { useState } from 'react';
import { FolderOpen, ChevronRight, ArrowLeft, Loader2, FolderPlus } from 'lucide-react';
import { useDirectoryListing, useCreateDirectory } from '@/hooks/use-file-manager';

/** Join a directory path with a child name (handles the root `/`). */
export function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

/**
 * Browse the tenant's storage tree and pick a folder. Live-lists folders via
 * `useDirectoryListing` (GET /files?path=) and can create a new folder in the
 * current location (`useCreateDirectory`). Rendered at z-[60] so it sits above
 * a parent modal it may be opened from.
 */
export default function FolderPickerDialog({
  title, description, initialPath, confirmLabel, isPending, onClose, onConfirm,
}: {
  readonly title: string;
  readonly description: string;
  readonly initialPath: string;
  readonly confirmLabel: string;
  readonly isPending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (path: string) => void;
}) {
  const [browsePath, setBrowsePath] = useState(initialPath || '/');
  const [newFolder, setNewFolder] = useState('');
  const listing = useDirectoryListing(browsePath, true);
  const createDir = useCreateDirectory();
  const folders = listing.data?.entries.filter(e => e.type === 'directory') ?? [];

  const handleNewFolder = async () => {
    const name = newFolder.trim();
    if (!name) return;
    const target = joinPath(browsePath, name);
    try {
      await createDir.mutateAsync(target);
    } catch (err) {
      // Ignore "already exists" — just navigate into it; surface anything else.
      if (!/exist/i.test((err as Error).message)) return;
    }
    setNewFolder('');
    setBrowsePath(target);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">{title}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{description}</p>

        {/* Current path breadcrumb */}
        <div className="flex items-center gap-1 text-sm mb-2 overflow-x-auto">
          <button onClick={() => setBrowsePath('/')} className="text-brand-600 hover:underline dark:text-brand-400">/</button>
          {browsePath.split('/').filter(Boolean).map((part, i, arr) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight size={12} className="text-gray-400" />
              <button onClick={() => setBrowsePath('/' + arr.slice(0, i + 1).join('/'))} className="text-brand-600 hover:underline dark:text-brand-400">{part}</button>
            </span>
          ))}
        </div>

        {/* Selected destination */}
        <div className="rounded-lg border-2 border-brand-500 bg-brand-50 dark:bg-brand-900/20 px-3 py-2 mb-3 text-sm font-medium text-brand-700 dark:text-brand-300">
          Destination: {browsePath}
        </div>

        {/* Folder list */}
        <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 mb-2">
          {browsePath !== '/' && (
            <button onClick={() => { const parts = browsePath.split('/').filter(Boolean); parts.pop(); setBrowsePath('/' + parts.join('/')); }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700">
              <ArrowLeft size={14} className="text-gray-400" /> ..
            </button>
          )}
          {listing.isLoading && <div className="flex items-center justify-center py-4"><Loader2 size={16} className="animate-spin text-gray-400" /></div>}
          {folders.length === 0 && !listing.isLoading && (
            <div className="px-3 py-4 text-sm text-gray-400 text-center">No subfolders</div>
          )}
          {folders.map(f => (
            <button key={f.name} onClick={() => setBrowsePath(joinPath(browsePath, f.name))}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700 last:border-b-0">
              <FolderOpen size={16} className="text-amber-500 shrink-0" />
              <span className="text-gray-700 dark:text-gray-300">{f.name}</span>
            </button>
          ))}
        </div>

        {/* New folder */}
        <div className="flex items-center gap-2 mb-3">
          <input
            type="text"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleNewFolder(); } }}
            placeholder="New folder name…"
            className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <button onClick={() => void handleNewFolder()} disabled={!newFolder.trim() || createDir.isPending}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">
            {createDir.isPending ? <Loader2 size={14} className="animate-spin" /> : <FolderPlus size={14} />} Create
          </button>
        </div>
        {createDir.error && !/exist/i.test((createDir.error as Error).message) && (
          <p className="text-xs text-red-600 dark:text-red-400 mb-2">{(createDir.error as Error).message}</p>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
          <button onClick={() => onConfirm(browsePath)} disabled={isPending} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
            {isPending && <Loader2 size={14} className="animate-spin inline mr-1" />}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
