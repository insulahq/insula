import { CheckCircle2, X } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useRecoverableTenants } from '@/hooks/use-dr-recover';
import { recoverTenantPath } from '@/components/backups/DeletedTenantsCard';

/** Router state the tenant page hands the list after a successful delete. */
export interface TenantDeletedState {
  readonly deletedTenant: { readonly name: string; readonly id?: string };
}

function readDeleted(state: unknown): TenantDeletedState['deletedTenant'] | null {
  const d = (state as Partial<TenantDeletedState> | null)?.deletedTenant;
  return d && typeof d.name === 'string' ? d : null;
}

/**
 * "Tenant X was deleted" on the tenants list, after the tenant page sent the
 * operator back here. The deletion's per-step record outlives the tenant on
 * Platform → Lifecycle hooks, so the banner points there instead of keeping a
 * page open on a tenant that no longer exists.
 */
export default function TenantDeletedBanner() {
  const location = useLocation();
  const navigate = useNavigate();
  const deleted = readDeleted(location.state);
  const recoverable = useRecoverableTenants();
  if (!deleted) return null;
  // Its bundles outlive it for the deleted-tenant window — say so, and how to
  // bring it back. A tenant that never had a bundle cannot be recovered at all.
  const entry = deleted.id
    ? (recoverable.data?.data ?? []).find((t) => t.tenantId === deleted.id && t.newestCompletedBundleId !== null)
    : undefined;

  // Clear the state, so a reload or a Back does not announce it again.
  const dismiss = (): void => {
    void navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  };

  return (
    <div
      role="status"
      data-testid="tenant-deleted-banner"
      className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900 dark:border-green-800 dark:bg-green-900/20 dark:text-green-200"
    >
      <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />
      <p className="flex-1">
        Tenant <strong>{deleted.name}</strong> was deleted.{' '}
        <Link
          to="/platform/lifecycle-hooks"
          className="font-medium text-green-800 underline underline-offset-2 hover:text-green-900 dark:text-green-300 dark:hover:text-green-200"
        >
          Review the deletion steps
        </Link>
        {entry && (
          <span className="mt-1 block" data-testid="tenant-deleted-recoverable">
            Its backups are kept{entry.keptUntil ? ` until ${entry.keptUntil.slice(0, 10)}` : ''}, so it can still be
            recovered —{' '}
            <Link
              to={recoverTenantPath(entry.tenantId)}
              className="font-medium text-green-800 underline underline-offset-2 hover:text-green-900 dark:text-green-300 dark:hover:text-green-200"
            >
              Recover…
            </Link>
          </span>
        )}
        {deleted.id && recoverable.isSuccess && !entry && (
          <span className="mt-1 block" data-testid="tenant-deleted-unrecoverable">
            It had no completed off-site backup, so it cannot be recovered.
          </span>
        )}
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="rounded p-0.5 text-green-700 hover:bg-green-100 dark:text-green-300 dark:hover:bg-green-800/40"
      >
        <X size={14} />
      </button>
    </div>
  );
}
