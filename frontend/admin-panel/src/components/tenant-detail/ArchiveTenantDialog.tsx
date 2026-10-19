import { useState } from 'react';
import { Loader2, ServerCrash } from 'lucide-react';

/**
 * Archive confirmation, with the one choice archiving takes: how long the
 * pre-archive snapshot is kept. That choice used to live in the status
 * dropdown on the account card; the dropdown is gone, the choice is not.
 */
export default function ArchiveTenantDialog({
  tenantName,
  busy,
  onConfirm,
  onClose,
}: {
  readonly tenantName: string;
  readonly busy: boolean;
  readonly onConfirm: (retentionDays: number) => void;
  readonly onClose: () => void;
}) {
  const [days, setDays] = useState('90');
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= 365;

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="archive-tenant-title" className="w-full max-w-lg rounded-xl bg-white shadow-xl dark:bg-gray-800" data-testid="archive-tenant-dialog">
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-3 dark:border-amber-800/50 dark:bg-amber-900/20">
          <h2 id="archive-tenant-title" className="flex items-center gap-2 text-base font-semibold text-amber-900 dark:text-amber-200">
            <ServerCrash size={18} aria-hidden="true" /> Archive {tenantName}?
          </h2>
        </div>
        <div className="space-y-3 p-5 text-sm text-gray-700 dark:text-gray-300">
          <p>
            A final snapshot is taken first. Then all mailboxes, aliases, deployments and the live volume are deleted.
            The tenant can be restored from the snapshot until it expires.
          </p>
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-300">Keep the snapshot for (days)</span>
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="mt-1 w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              data-testid="archive-retention-input"
            />
          </label>
          {!valid && <p className="text-xs text-red-600 dark:text-red-400">Between 1 and 365 days.</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(n)}
            disabled={busy || !valid}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            data-testid="archive-confirm"
          >
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            Archive tenant
          </button>
        </div>
      </div>
    </div>
  );
}
