import { useEffect, useRef } from 'react';
import { X, HelpCircle, AlertTriangle } from 'lucide-react';

/**
 * Explains the application-root / document-root pair for a multi-host route,
 * and states the two paths the site actually runs on.
 *
 * The pair is the part operators get wrong: both are folders, both look like
 * a "web root", and picking the wrong one either exposes the whole codebase
 * or serves a 403. The modal names the distinction once, next to the real
 * values, instead of leaving it to a tooltip nobody hovers.
 *
 * Every path shown is derived from the catalog manifest's `sites_root` — the
 * same value the vhost renderer uses — so what is displayed is what the
 * generated config contains, not a reconstruction that can drift from it.
 */

export interface MultihostRootsHelpModalProps {
  readonly hostname: string;
  /** Folder relative to the tenant volume, as File Manager shows it. */
  readonly appRoot: string | null;
  /** Document root, also volume-relative. Equal to appRoot when unset. */
  readonly siteFolder: string | null;
  /** Where the pod mounts the tenant volume, from the catalog manifest. */
  readonly sitesRoot: string | null;
  readonly onClose: () => void;
}

function PathRow({ label, pvcPath, internalPath }: {
  readonly label: string;
  readonly pvcPath: string | null;
  readonly internalPath: string | null;
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-200">{label}</div>
      <dl className="mt-2 space-y-1.5">
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            In File Manager
          </dt>
          <dd className="break-all font-mono text-xs text-gray-900 dark:text-gray-100">
            {pvcPath ? `/${pvcPath}` : <span className="text-gray-400 dark:text-gray-500">not set</span>}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Inside the container
          </dt>
          <dd className="break-all font-mono text-xs text-gray-900 dark:text-gray-100">
            {internalPath ?? <span className="text-gray-400 dark:text-gray-500">not set</span>}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function MultihostRootsHelpModal({
  hostname, appRoot, siteFolder, sitesRoot, onClose,
}: MultihostRootsHelpModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const abs = (rel: string | null) => (rel && sitesRoot ? `${sitesRoot}/${rel}` : null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="multihost-roots-help-title"
      data-testid="multihost-roots-help"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2
            id="multihost-roots-help-title"
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            Document root and application root
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close"
            data-testid="multihost-roots-help-close"
          >
            <X size={18} />
          </button>
        </div>

        <p className="mt-1 break-all font-mono text-xs text-gray-500 dark:text-gray-400">{hostname}</p>

        <div className="mt-4 space-y-3 text-sm text-gray-700 dark:text-gray-300">
          <p>
            <strong className="text-gray-900 dark:text-gray-100">Application root</strong> is the
            folder holding the whole application — code, configuration and data. The site can only
            read files inside it, so anything the application needs at runtime must live here.
          </p>
          <p>
            <strong className="text-gray-900 dark:text-gray-100">Document root</strong> is the
            folder actually served on the web. Modern applications keep it in a sub-folder such as{' '}
            <code className="rounded bg-gray-100 dark:bg-gray-700 px-1 py-0.5 text-xs">public</code>{' '}
            or <code className="rounded bg-gray-100 dark:bg-gray-700 px-1 py-0.5 text-xs">web</code>{' '}
            so that source files and secrets sit beside it rather than under it. It must be inside
            the application root — the folder picker enforces that.
          </p>
          <p className="flex gap-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-xs text-blue-800 dark:text-blue-300">
            <HelpCircle size={14} className="mt-0.5 shrink-0" />
            <span>
              Leave the document root unset to serve the application root itself. That is right for
              applications that expect to be served from their top-level folder, and wrong for any
              framework that ships a <code>public/</code> directory — serving the parent there would
              expose configuration files to the internet.
            </span>
          </p>
        </div>

        <div className="mt-4 space-y-2">
          <PathRow label="Application root" pvcPath={appRoot} internalPath={abs(appRoot)} />
          <PathRow
            label={siteFolder && siteFolder !== appRoot ? 'Document root' : 'Document root (same as application root)'}
            pvcPath={siteFolder ?? appRoot}
            internalPath={abs(siteFolder ?? appRoot)}
          />
        </div>

        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          Use the <em>File Manager</em> path when uploading files, and the container path when an
          application&apos;s own configuration file asks for an absolute directory.
        </p>
      </div>
    </div>
  );
}

export interface ClearDocumentRootConfirmProps {
  readonly hostname: string;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Confirmation for clearing a route's document root.
 *
 * Enter confirms, Escape cancels. The button is focused on mount so Enter
 * works without the user first clicking into the dialog — a keydown listener
 * alone would fire while focus was still on the page behind it.
 */
export function ClearDocumentRootConfirm({
  hostname, isPending, onConfirm, onCancel,
}: ClearDocumentRootConfirmProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCancel(); return; }
      // Guard on isPending so holding Enter cannot fire a second request while
      // the first is still in flight.
      if (e.key === 'Enter' && !isPending) { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel, isPending]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clear-docroot-title"
      data-testid="clear-docroot-confirm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
            <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0">
            <h2 id="clear-docroot-title" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Clear the document root?
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              <span className="break-all font-mono text-xs">{hostname}</span> will serve the
              application root instead. No files are deleted — only which folder is published
              changes.
            </p>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            data-testid="clear-docroot-cancel"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            data-testid="clear-docroot-confirm-button"
          >
            {isPending ? 'Clearing…' : 'Clear'}
          </button>
        </div>
        <p className="mt-2 text-right text-[11px] text-gray-400 dark:text-gray-500">
          Press <kbd className="rounded border border-gray-300 dark:border-gray-600 px-1">Enter</kbd> to confirm
        </p>
      </div>
    </div>
  );
}
