import { Archive, Loader2, Play } from 'lucide-react';
import { useTenantArchive } from '@/hooks/use-tenant-archive';
import { formatBytes } from '@/lib/format-snapshot-size';

const longDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

/**
 * An archived tenant's page (operator spec): nothing but the archive — the
 * ARCHIVED notice, the archive bundle's date and size, how long it is kept,
 * and the way back. The sections a live tenant has describe what the archive
 * removed; they would show nothing true.
 */
export default function ArchivedTenantView({
  tenantId,
  restoring,
  keptOutOfAutomation = false,
  onRestore,
}: {
  readonly tenantId: string;
  readonly restoring: boolean;
  /** Kept out of automatic archive and delete: an expired archive waits instead of deleting the tenant. */
  readonly keptOutOfAutomation?: boolean;
  readonly onRestore: (whole: boolean) => void;
}) {
  const { data, isLoading, isError } = useTenantArchive(tenantId);
  const info = data?.data;

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
          {info.bundle && !info.bundle.whole && (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-400" data-testid="archive-files-only">
              This archive is from before archives held everything: it holds the files only. Restoring brings the files
              back; applications and mailboxes have to be set up again.
            </p>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => onRestore(info.bundle?.whole ?? false)}
              disabled={!info.restorable || restoring}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
              data-testid="restore-archived-button"
            >
              {restoring ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
              Restore archived tenant
            </button>
            {!info.restorable && info.notRestorableReason && (
              <span className="text-sm text-gray-500 dark:text-gray-400" data-testid="archive-not-restorable">{info.notRestorableReason}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
