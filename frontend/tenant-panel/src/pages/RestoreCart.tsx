/**
 * Tenant restore-cart page (thin wrapper).
 *
 * Renders the same `RestoreCartLayout` the admin panel uses (from
 * @insula/ui-restore-cart) so the UI is identical between the
 * two panels. Differences:
 *
 *   - Tenant hook bag points at /api/v1/tenants/:tenantId/... routes
 *     (server-side `assertOwnership` + `tenant-restore-policy` block
 *     cross-tenant access AND denied tables/columns regardless of
 *     what the UI sends).
 *   - `showRollback={false}`: tenants can't roll back destructive ops
 *     without operator review. The tenant rollback route is gated to
 *     `requireRole('super_admin','admin')` server-side (defence in
 *     depth — see backup-restore/tenant-routes.ts), so even a forged
 *     POST returns 403. Hiding the button keeps the UI honest.
 *   - Header banner renders a "back to backups" breadcrumb so tenants
 *     navigate back to /backups, not the admin's restore-list.
 */
import { useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { RestoreCartLayout, type RestoreCartHooks } from '@insula/ui-restore-cart';

import { useAuth } from '@/hooks/use-auth';
import {
  useRestoreCart,
  useCreateRestoreCart,
  useAddRestoreItem,
  useRemoveRestoreItem,
  useExecuteRestoreCart,
  useBrowseConfigTables,
  useBrowseDeployments,
  useBrowseDomains,
  useBrowseMailboxes,
  useBrowseFiles,
} from '@/hooks/use-restore-carts';

// Module-scope hook bag — stable across renders. Tenant panel
// intentionally omits `useRollbackCart`.
const tenantHooks: RestoreCartHooks = {
  useCart: useRestoreCart as RestoreCartHooks['useCart'],
  useCreateCart: useCreateRestoreCart as RestoreCartHooks['useCreateCart'],
  useAddItem: useAddRestoreItem as RestoreCartHooks['useAddItem'],
  useRemoveItem: useRemoveRestoreItem as RestoreCartHooks['useRemoveItem'],
  useExecuteCart: useExecuteRestoreCart as RestoreCartHooks['useExecuteCart'],
  // useRollbackCart intentionally omitted.
  useBrowseConfigTables: useBrowseConfigTables as RestoreCartHooks['useBrowseConfigTables'],
  useBrowseDeployments: useBrowseDeployments as RestoreCartHooks['useBrowseDeployments'],
  useBrowseDomains: useBrowseDomains as RestoreCartHooks['useBrowseDomains'],
  useBrowseMailboxes: useBrowseMailboxes as RestoreCartHooks['useBrowseMailboxes'],
  useBrowseFiles: useBrowseFiles as RestoreCartHooks['useBrowseFiles'],
};

const Breadcrumb = () => (
  <div className="mb-3">
    <Link
      to="/backups"
      className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
    >
      <ArrowLeft size={12} /> Back to backups
    </Link>
  </div>
);

export default function TenantRestoreCart() {
  const { bundleId } = useParams<{ bundleId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tenantId = useAuth((s) => s.user?.tenantId) ?? null;

  // The cart id lives in the URL (`?cart=<id>`).
  //
  // It used to be component state only, with the note that a reload just
  // re-created a fresh cart and the 7-day sweep would collect the orphan. Two
  // consequences that turned out to matter: a half-built cart was lost on any
  // reload or accidental back-navigation, and every abandoned attempt left a
  // draft behind — which is what a tenant sees in "Recent restore carts" with
  // no way to get back into one.
  //
  // With the id in the URL the page is resumable: the Backups list links
  // straight to an existing cart, reloads keep their place, and the layout
  // only auto-creates when there is genuinely no cart yet.
  const cartId = searchParams.get('cart');

  const handleCartCreated = useCallback((id: string) => {
    // `replace` so the empty-cart URL doesn't become a back-button stop.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('cart', id);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  return (
    <RestoreCartLayout
      hooks={tenantHooks}
      bundleId={bundleId ?? null}
      tenantId={tenantId}
      cartId={cartId}
      showRollback={false}
      headerBanner={<Breadcrumb />}
      onCartCreated={handleCartCreated}
    />
  );
}
