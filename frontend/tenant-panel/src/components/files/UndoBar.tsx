import { useEffect } from 'react';
import { Loader2, RotateCcw, Trash2, X } from 'lucide-react';

/**
 * The affordance that makes a recycle bin actually usable: right after a
 * delete, say what happened and offer to put it back — without making the user
 * find the bin, scan a list and match a filename.
 *
 * Without this the bin is only reachable by noticing a small chip next to the
 * storage figure, which is a discovery problem exactly when the user is most
 * anxious. Restoring from here is one click on the thing they just did.
 *
 * Deliberately NOT auto-dismissing on a timer while a restore is in flight, and
 * deliberately not a toast stack: one action, one bar, dismissible.
 */
export interface UndoState {
  /** Trash entry ids that can be put back. */
  readonly ids: readonly string[];
  readonly label: string;
  /** Set when the delete skipped the bin — there is nothing to undo, and
   *  saying so is more honest than offering a button that cannot work. */
  readonly permanent: boolean;
}

export default function UndoBar({
  state, onUndo, onDismiss, isRestoring, autoDismissMs = 12_000,
}: {
  readonly state: UndoState;
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
  readonly isRestoring: boolean;
  readonly autoDismissMs?: number;
}) {
  useEffect(() => {
    if (isRestoring) return undefined; // never yank the bar out from under a click
    const t = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(t);
  }, [isRestoring, onDismiss, autoDismissMs, state]);

  const canUndo = !state.permanent && state.ids.length > 0;

  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-800/60"
      data-testid="undo-bar"
    >
      <Trash2 size={16} className="shrink-0 text-gray-400 dark:text-gray-500" />
      <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-300">{state.label}</span>
      {canUndo ? (
        <button
          onClick={onUndo}
          disabled={isRestoring}
          className="inline-flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:text-brand-400 dark:hover:bg-brand-900/30"
          data-testid="undo-delete"
        >
          {isRestoring ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} Undo
        </button>
      ) : (
        <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">Permanently deleted — cannot be undone</span>
      )}
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
      >
        <X size={14} />
      </button>
    </div>
  );
}
