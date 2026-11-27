/**
 * Confirm "Repair database access" for one tenant database instance.
 *
 * For the case the admin notification "Platform lost its login to a tenant
 * database" reports: the platform can no longer log in as administrator, so
 * the tenant's SQL Manager, logical backups and restores of that instance
 * fail. The repair redeploys the instance with a reset that restores the
 * platform's login before the database starts — the database restarts once.
 */
import { useEffect, useRef } from 'react';
import { Loader2, Wrench } from 'lucide-react';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

interface RepairDatabaseAccessDialogProps {
  readonly deploymentName: string;
  readonly pending: boolean;
  /** The failed attempt's error, or null. */
  readonly error: unknown;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export default function RepairDatabaseAccessDialog({
  deploymentName, pending, error, onConfirm, onCancel,
}: RepairDatabaseAccessDialogProps) {
  const close = () => { if (!pending) onCancel(); };
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus starts on Cancel — the safe choice for an action that restarts a
  // tenant's database — and Escape closes, as for every dialog.
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pending, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="repair-db-access-dialog">
      <div className="fixed inset-0 bg-black/50" onClick={close} aria-hidden="true" />
      <div
        className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
        role="dialog"
        aria-modal="true"
        aria-labelledby="repair-db-access-title"
        aria-describedby="repair-db-access-body"
      >
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
            <Wrench size={20} className="text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0 space-y-2 text-sm text-gray-600 dark:text-gray-400" id="repair-db-access-body">
            <h2 id="repair-db-access-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Repair database access
            </h2>
            <p>
              Use this when the platform has lost its administrator login to{' '}
              <strong className="font-mono text-gray-900 dark:text-gray-100">{deploymentName}</strong> — the
              notification <em>Platform lost its login to a tenant database</em> names the instances. Until it is
              repaired, the tenant&apos;s SQL Manager, logical backups and restores of this database fail.
            </p>
            <p>
              The instance is redeployed with a reset that restores the platform&apos;s login before the database
              starts. The tenant&apos;s data and its own database accounts are not touched.
            </p>
            <p
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
              data-testid="repair-db-access-restart-warning"
            >
              The database restarts once: applications using it are briefly unavailable.
            </p>
          </div>
        </div>

        {error != null && (
          <div className="mt-4">
            <ErrorPanel error={extractOperatorError(error)} compact testId="repair-db-access-error" />
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={close}
            disabled={pending}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700/50"
            data-testid="repair-db-access-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50 dark:bg-amber-600 dark:hover:bg-amber-500"
            data-testid="repair-db-access-confirm"
          >
            {pending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            Repair and restart
          </button>
        </div>
      </div>
    </div>
  );
}
