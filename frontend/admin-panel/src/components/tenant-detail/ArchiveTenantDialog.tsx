import { useState } from 'react';
import { Loader2, ServerCrash } from 'lucide-react';

/** What the dialog hands back: days to keep the archive, or null for no end date. */
export type ArchiveRetention = number | null;

/**
 * Archive confirmation, with the one choice archiving takes: how long the
 * archive's bundle — the tenant's final full backup — is kept. When it
 * expires the tenant is deleted; "Never expire" keeps it until someone
 * deletes the tenant by hand.
 */
export default function ArchiveTenantDialog({
  tenantName,
  busy,
  defaultDays = 90,
  onConfirm,
  onClose,
}: {
  readonly tenantName: string;
  readonly busy: boolean;
  /** The platform's archive retention, used until the admin changes it. */
  readonly defaultDays?: number;
  readonly onConfirm: (retention: ArchiveRetention) => void;
  readonly onClose: () => void;
}) {
  const [days, setDays] = useState(String(defaultDays));
  const [neverExpires, setNeverExpires] = useState(false);
  const n = Number(days);
  const valid = neverExpires || (Number.isInteger(n) && n >= 1 && n <= 3650);

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
            A final backup bundle is taken first — files, databases, mailboxes with their mail, configuration —
            and stored off-site. Then the tenant is taken down almost as if deleted:
          </p>
          <ul className="list-disc space-y-1 pl-5" data-testid="archive-consequences">
            <li>nobody can sign in to it any more;</li>
            <li>its applications, volume and mailboxes are removed;</li>
            <li>its DNS zones, mail domains and DKIM keys are removed.</li>
          </ul>
          <p>
            Restoring brings all of it back from the bundle. Mailboxes come back with their mail but need new passwords.
          </p>
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-300">Keep the archive for (days)</span>
            <input
              type="number"
              min={1}
              max={3650}
              value={days}
              disabled={neverExpires}
              onChange={(e) => setDays(e.target.value)}
              className="mt-1 w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              data-testid="archive-retention-input"
            />
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={neverExpires}
              onChange={(e) => setNeverExpires(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
              data-testid="archive-never-expires"
            />
            <span>
              <span className="font-medium">Never expire</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                {neverExpires
                  ? 'The archive is kept until the tenant is deleted by hand.'
                  : 'When the archive expires, the tenant is deleted.'}
              </span>
            </span>
          </label>
          {!valid && <p className="text-xs text-red-600 dark:text-red-400">Between 1 and 3650 days.</p>}
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
            onClick={() => onConfirm(neverExpires ? null : n)}
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
