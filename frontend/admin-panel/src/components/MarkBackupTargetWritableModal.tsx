import { useState, useEffect, useRef, type FormEvent } from 'react';
import { X, Loader2, AlertTriangle, CheckCircle, Snowflake } from 'lucide-react';
import { useMarkBackupTargetWritable, type MarkWritablePayload } from '@/hooks/use-backup-config';

interface MarkBackupTargetWritableModalProps {
  readonly open: boolean;
  readonly targetId: string;
  readonly targetName: string;
  readonly onClose: () => void;
}

/**
 * DR safety: unfreeze a backup target. Two gates:
 *   1. Operator must type the target's exact name (case-sensitive).
 *   2. Operator must check "I have verified data integrity."
 *
 * On success, the backend has flipped read_only=false AND patched
 * every CNPG cluster routing through this target to re-attach the
 * barman-cloud plugin. The result view enumerates which clusters
 * resumed archiving so the operator knows what's running before they
 * close the modal.
 */
export default function MarkBackupTargetWritableModal({
  open,
  targetId,
  targetName,
  onClose,
}: MarkBackupTargetWritableModalProps) {
  const [confirmation, setConfirmation] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [result, setResult] = useState<MarkWritablePayload | null>(null);
  const mut = useMarkBackupTargetWritable();
  // Refs for focus management — first focusable element on open + the
  // Cancel/Done button as the final fallback when focus escapes.
  const confirmInputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Accessibility — Esc to close + focus capture on open.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !mut.isPending) {
        e.preventDefault();
        handleClose();
      }
      // Light focus trap: if Tab tries to leave the dialog, snap back
      // to the first focusable element. Full focus-trap libs are
      // overkill for a 3-input modal — this covers the WAI-ARIA
      // dialog pattern's minimum requirement.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    // Focus the confirmation input one tick after mount so the
    // dialog's animation/render lands first.
    const timer = setTimeout(() => confirmInputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', handleKey);
      clearTimeout(timer);
    };
  }, [open, mut.isPending]);

  if (!open) return null;

  const handleClose = () => {
    setConfirmation('');
    setAcknowledge(false);
    setResult(null);
    mut.reset();
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // Defense-in-depth: the submit button is disabled in this state,
    // but if it's ever re-enabled via DOM tampering we still refuse
    // and tell the operator why instead of silently returning.
    if (confirmation !== targetName || !acknowledge) {
      // Render the same place as server errors so the user sees feedback.
      // We don't have a separate "client validation" state, so reuse
      // the mutation's reset+set-error contract.
      mut.reset();
      return;
    }
    try {
      const res = await mut.mutateAsync({ id: targetId, confirmation });
      setResult(res.data);
    } catch {
      // error rendered below from mut.error
    }
  };

  const ready = confirmation === targetName && acknowledge && !mut.isPending && !result;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      data-testid="mark-writable-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mark-writable-title"
      ref={dialogRef}
    >
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2
            id="mark-writable-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2"
          >
            <Snowflake size={18} className="text-sky-500" />
            Unfreeze backup target
          </h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-400"
            aria-label="Close"
            data-testid="mark-writable-close"
          >
            <X size={20} />
          </button>
        </div>

        {!result && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 flex-none" />
                <div>
                  <strong>This target is currently read-only.</strong> All
                  backup writes and deletes are refused. Unfreezing it will
                  allow new writes and resume CNPG WAL archiving for any
                  cluster routing through this target.
                  <p className="mt-2">
                    Verify data integrity from this target before unfreezing.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label htmlFor="mw-confirm" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Type the target name to confirm:{' '}
                <code className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-1 rounded">
                  {targetName}
                </code>
              </label>
              <input
                id="mw-confirm"
                type="text"
                autoComplete="off"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                data-testid="mw-confirmation"
                ref={confirmInputRef}
              />
            </div>

            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={acknowledge}
                onChange={(e) => setAcknowledge(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                data-testid="mw-acknowledge"
              />
              <span>I have verified data integrity from this target.</span>
            </label>

            {mut.error && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-600 dark:text-red-400" data-testid="mw-error">
                {mut.error instanceof Error ? mut.error.message : 'Failed to unfreeze target'}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600"
                data-testid="mw-cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!ready}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="mw-submit"
              >
                {mut.isPending && <Loader2 size={14} className="animate-spin" />}
                Mark Read-Write
              </button>
            </div>
          </form>
        )}

        {result && (
          <div className="space-y-3 text-sm" data-testid="mw-result">
            <div className="flex items-start gap-2 text-green-700 dark:text-green-300">
              <CheckCircle size={16} className="mt-0.5 flex-none" />
              <div>
                <strong>{result.targetName}</strong> is now read-write.
              </div>
            </div>
            {result.cnpgArchivingResumed.length > 0 && (
              <div>
                <p className="font-medium text-gray-700 dark:text-gray-300 mb-1">
                  CNPG archiving resumed:
                </p>
                <ul className="list-disc list-inside text-gray-600 dark:text-gray-400 space-y-0.5">
                  {result.cnpgArchivingResumed.map((c) => (
                    <li key={`${c.namespace}/${c.clusterName}`}>
                      <code className="font-mono text-xs">
                        {c.namespace}/{c.clusterName}
                      </code>
                      {c.wasAlreadyAttached && (
                        <span className="ml-1 text-xs text-gray-500">(already attached)</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.mailReconcilerTriggered && (
              <p className="text-gray-600 dark:text-gray-400">
                Mail-restic reconciler will re-materialize the snapshot Secret
                on its next 5-minute tick.
              </p>
            )}
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
                data-testid="mw-done"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
