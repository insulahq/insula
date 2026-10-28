import { Archive, Loader2, Play } from 'lucide-react';
import { useTenantArchive } from '@/hooks/use-tenant-archive';
import { useStorageOperations } from '@/hooks/use-storage-lifecycle';
import { FailedStorageOperation } from './FailedStorageOperation';
import { formatBytes } from '@/lib/format-bytes';

const longDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

/**
 * An archived tenant's page (operator spec): nothing but the archive — the
 * ARCHIVED notice, the archive bundle's date and size, how long it is kept,
 * and the way back. The sections a live tenant has describe what the archive
 * removed; they would show nothing true.
 *
 * A restore that failed leaves the tenant in the `failed` storage state, which
 * refuses the next restore. This page has no Storage tab, so the failed
 * operation's error and its Reset to idle are shown here.
 */
export default function ArchivedTenantView({
  tenantId,
  storageState = 'idle',
  restoring,
  keptOutOfAutomation = false,
  onRestore,
}: {
  readonly tenantId: string;
  /** The tenant's storage lifecycle state; a restore needs it idle. */
  readonly storageState?: string;
  readonly restoring: boolean;
  /** Kept out of automatic archive and delete: an expired archive waits instead of deleting the tenant. */
  readonly keptOutOfAutomation?: boolean;
  /** Opens the restore dialog (the node and the size it comes back with). */
  readonly onRestore: () => void;
}) {
  const { data, isLoading, isError } = useTenantArchive(tenantId);
  const info = data?.data;
  const ops = useStorageOperations(tenantId).data?.data ?? [];
  const runningOp = ops.find((o) => o.state !== 'idle' && o.state !== 'failed' && !o.completedAt);
  // The reset is the only way out of `failed` this page has, so it is shown
  // whenever the tenant is failed: with the newest failed operation's error
  // when there is one to read, without it when not.
  const failedOp = ops.find((o) => o.state === 'failed') ?? null;
  // Why Restore is off: the storage state first, as it is the tenant's own
  // and the archive info may be a read older.
  const blockedBy = storageState === 'failed'
    ? 'The last storage operation failed. Reset to idle, then restore.'
    : storageState !== 'idle'
      ? `A storage operation is running (${runningOp?.progressMessage ?? storageState}).`
      : !info?.restorable ? info?.notRestorableReason ?? 'The archive cannot be restored.' : null;

  return (
    <section
      className="rounded-xl border border-slate-300 bg-white p-6 shadow-sm dark:border-slate-600 dark:bg-gray-800"
      data-testid="archived-tenant-view"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200">
          <Archive size={20} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold tracking-wide text-slate-800 dark:text-slate-100">ARCHIVED</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            This tenant is archived{info?.archivedAt ? ` since ${longDate(info.archivedAt)}` : ''}. Nobody can sign in
            to it, and its applications, volume, mailboxes, DNS zones and mail domains have been removed. Its archive
            bundle is all that is kept.
          </p>
        </div>
      </div>

      {isLoading && (
        <p className="mt-5 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Reading the archive…
        </p>
      )}
      {isError && (
        <p className="mt-5 text-sm text-red-600 dark:text-red-400">The archive could not be read.</p>
      )}

      {info && (
        <>
          <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="archive-bundle">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Archive bundle</dt>
              <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="archive-bundle-date">
                {info.bundle ? longDate(info.bundle.createdAt) : 'None'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Size</dt>
              <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="archive-bundle-size">
                {info.bundle ? formatBytes(info.bundle.sizeBytes) : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Kept</dt>
              <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="archive-expiry">
                {!info.expiresAt
                  ? 'with no end date'
                  : keptOutOfAutomation
                    ? `until ${longDate(info.expiresAt)} — the tenant is kept out of automatic archive and delete, so it is not deleted then`
                    : `until ${longDate(info.expiresAt)}, then the tenant is deleted`}
              </dd>
            </div>
          </dl>
          {info.target && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400" data-testid="archive-target">
              Stored on {info.target.name}{info.target.bound ? '' : ' — not the target tenant backups use now; a restore reads it through a temporary, read-only connection'}.
            </p>
          )}
          {info.bundle && !info.bundle.whole && (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-400" data-testid="archive-files-only">
              This archive is from before archives held everything: it holds the files only. Restoring brings the files
              back; applications and mailboxes have to be set up again.
            </p>
          )}
          {storageState === 'failed' && (
            <div className="mt-5">
              <FailedStorageOperation tenantId={tenantId} op={failedOp} />
            </div>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onRestore}
              disabled={blockedBy !== null || restoring}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
              data-testid="restore-archived-button"
            >
              {restoring ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
              Restore archived tenant…
            </button>
            {blockedBy && (
              <span className="text-sm text-gray-500 dark:text-gray-400" data-testid="archive-not-restorable">{blockedBy}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
