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
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
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
  const tenantId = useAuth((s) => s.user?.tenantId) ?? null;

  // Local state holds the cartId after the layout auto-creates it.
  // We don't persist into the URL — the tenant route is
  // `/backups/restore/:bundleId`, and tenants don't share restore-cart
  // links across users. A page reload re-creates a fresh empty cart
  // (the 7-day cleanup tick sweeps the orphaned draft) — that's the
  // MVP tradeoff for not adding `?cartId=` URL state.
  const [cartId, setCartId] = useState<string | null>(null);

  return (
    <RestoreCartLayout
      hooks={tenantHooks}
      bundleId={bundleId ?? null}
      tenantId={tenantId}
      cartId={cartId}
      showRollback={false}
      headerBanner={<Breadcrumb />}
      onCartCreated={(id) => setCartId(id)}
    />
  );
}
