import { X, Loader2, FileText, ExternalLink, AlertTriangle } from 'lucide-react';
import { usePlatformChangelog } from '@/hooks/use-platform-updates';

/**
 * Release notes for the version about to be installed, opened from the upgrade
 * review modal.
 *
 * It carries its own "Approve & upgrade" so reading the notes is not a detour:
 * an operator who has just read what changed can commit from here instead of
 * backing out to the previous modal to press the same button. Cancel closes
 * only this modal and returns to the review, which still holds the pre-flight
 * result — nothing is re-fetched and no decision is lost.
 *
 * Notes render as pre-formatted text, not parsed markdown. The body is remote
 * content, and rendering it as HTML would put a third party's markup inside an
 * authenticated admin page; `whitespace-pre-wrap` keeps the release's own
 * line structure readable without that exposure.
 */
interface Props {
  /** Resolved target version — without this there is nothing to fetch. */
  readonly version: string | undefined;
  /** Fires the real apply. Same handler the review modal's button uses. */
  readonly onApprove: () => void;
  readonly onClose: () => void;
  /** False when pre-flight has blocking failures or an apply is already running. */
  readonly canApprove: boolean;
  readonly applying: boolean;
}

export default function ChangelogModal({ version, onApprove, onClose, canApprove, applying }: Props) {
  const { data, isLoading, error } = usePlatformChangelog(version);
  const changelog = data?.data;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <FileText className="h-4 w-4" />
            Changelog{version ? <span className="font-mono text-gray-500 dark:text-gray-400">v{version}</span> : null}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            aria-label="Close changelog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="changelog-body">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading release notes…
            </div>
          ) : error ? (
            /* The endpoint reports unreachability in `source` rather than
               failing, so reaching this branch means the request itself broke
               (logged out, proxy error) — say so instead of implying the
               release has no notes. */
            <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Could not load the changelog. The upgrade itself is unaffected — you can still approve it.</span>
            </div>
          ) : changelog?.notes ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-gray-800 dark:text-gray-200">
              {changelog.notes}
            </pre>
          ) : changelog?.source === 'unreachable' ? (
            <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Release notes could not be fetched — this cluster may have no outbound access to GitHub.
                This says nothing about the release itself.
              </span>
            </div>
          ) : (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              No release notes were published for this version.
              {version?.includes('-') ? ' Development builds carry no release page.' : ''}
            </div>
          )}

          {changelog?.url && (
            <a
              href={changelog.url}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-4 inline-flex items-center gap-1.5 text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              View the release on GitHub <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            data-testid="changelog-cancel-btn"
            className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="changelog-approve-upgrade-btn"
            onClick={onApprove}
            disabled={!canApprove}
            title={!canApprove ? 'Pre-flight has blocking failures' : ''}
            className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {applying ? <><Loader2 className="h-4 w-4 animate-spin" /> Starting…</> : 'Approve & upgrade →'}
          </button>
        </div>
      </div>
    </div>
  );
}
