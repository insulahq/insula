import { CheckCircle2, X } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

/** Router state the tenant page hands the list after a successful delete. */
export interface TenantDeletedState {
  readonly deletedTenant: { readonly name: string };
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
  if (!deleted) return null;

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
