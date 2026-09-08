import { useState } from 'react';
import { FolderOpen, ChevronRight, ArrowLeft, Loader2, AlertCircle } from 'lucide-react';
import { useTenantDirectoryListing } from '@/hooks/use-tenant-files';

/** Join a directory path with a child name (handles the root `/`). */
function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

/**
 * Pick a folder on a tenant's storage.
 *
 * Deliberately offers no "create folder": a site folder has to be one that
 * already holds the site, and an empty folder produces a route that resolves to
 * nothing — a broken site rather than an empty one. The tenant panel's picker
 * makes the same choice.
 */
export default function TenantFolderPicker({
  tenantId, initialPath, isPending, onClose, onConfirm, title, description, confineTo,
}: {
  readonly tenantId: string;
  readonly initialPath: string;
  readonly isPending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (path: string) => void;
  readonly title?: string;
  readonly description?: string;
  /**
   * Restrict browsing to this subtree. The document-root picker passes the
   * application root: outside it the site's PHP is sandboxed away from its own
   * document root, which 500s every request for a reason far from the symptom.
   */
  readonly confineTo?: string;
}) {
  const root = confineTo && confineTo !== '/' ? `/${confineTo.replace(/^\/+|\/+$/g, '')}` : '/';
  const [browsePath, setBrowsePath] = useState(initialPath || root);
  /** Never navigate above the confinement root. */
  const within = (pth: string) => (root === '/' || pth === root || pth.startsWith(`${root}/`) ? pth : root);
  const listing = useTenantDirectoryListing(tenantId, browsePath, true);
  // Gate the empty state on the absence of an ERROR, not just on an empty
  // array: `data?.entries ?? []` turns a failed request into "no folders here",
  // and the admin would create a duplicate rather than see the failure.
  const failed = Boolean(listing.error);
  const folders = (listing.data?.entries ?? []).filter((e) => e.type === 'directory');

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
          Choose the folder this hostname serves
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          Any folder on the tenant's storage. The hostname serves it as its document root.
        </p>

        <div className="mb-2 flex items-center gap-2 text-xs font-mono text-gray-600 dark:text-gray-300">
          {browsePath !== root && (
            <button
              type="button"
              onClick={() => setBrowsePath(within(browsePath.replace(/\/[^/]+$/, '') || '/'))}
              className="inline-flex items-center gap-1 rounded border border-gray-200 dark:border-gray-600 px-1.5 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-700"
              data-testid="folder-picker-up"
            >
              <ArrowLeft size={11} /> up
            </button>
          )}
          <span data-testid="folder-picker-path">{browsePath}</span>
        </div>

        <div className="mb-3 max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700">
          {listing.isLoading && (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          )}
          {failed && (
            <div className="flex items-start gap-2 px-3 py-3 text-sm text-red-600 dark:text-red-400" data-testid="folder-picker-error">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>
                Could not read this tenant's storage.
                {listing.error instanceof Error ? ` ${listing.error.message}` : ''}
              </span>
            </div>
          )}
          {!listing.isLoading && !failed && folders.length === 0 && (
            <p className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">No folders here.</p>
          )}
          {!failed && folders.map((f) => (
            <button
              key={f.name}
              type="button"
              onClick={() => setBrowsePath(joinPath(browsePath, f.name))}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/50"
              data-testid={`folder-picker-entry-${f.name}`}
            >
              <span className="inline-flex items-center gap-2 font-mono text-xs">
                <FolderOpen size={13} /> {f.name}
              </span>
              <ChevronRight size={13} className="text-gray-400" />
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(browsePath)}
            disabled={isPending || browsePath === '/'}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            data-testid="folder-picker-confirm"
          >
            {isPending && <Loader2 size={13} className="animate-spin" />}
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
