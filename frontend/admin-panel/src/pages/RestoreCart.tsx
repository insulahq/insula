/**
 * Admin restore-cart page (thin wrapper).
 *
 * The 500-line implementation lives in `@k8s-hosting/ui-restore-cart`
 * as `RestoreCartLayout`. This wrapper:
 *   - Reads cart context from the URL query string
 *     (`?bundleId=…&tenantId=…&cartId=…`)
 *   - Provides the admin-specific hooks bag (URLs under
 *     `/api/v1/admin/restores/...`) including the rollback hook
 *   - Renders the shared layout with `showRollback`
 */
import { useSearchParams } from 'react-router-dom';
import { RestoreCartLayout, type RestoreCartHooks } from '@k8s-hosting/ui-restore-cart';

import {
  useRestoreCart,
  useCreateRestoreCart,
  useAddRestoreItem,
  useRemoveRestoreItem,
  useExecuteRestoreCart,
  useRollbackRestoreCart,
  useBrowseConfigTables,
  useBrowseDeployments,
  useBrowseDomains,
  useBrowseMailboxes,
  useBrowseFiles,
} from '@/hooks/use-restore-carts';

// Module-scope hook bag — stable identity across renders so the
// shared layout's `hooks.useCart(...)` call position is stable.
// (Note: types are wider than the layout's RestoreCartHooks
// interface, the structural subtype matches at the call sites.)
const adminHooks: RestoreCartHooks = {
  useCart: useRestoreCart as RestoreCartHooks['useCart'],
  useCreateCart: useCreateRestoreCart as RestoreCartHooks['useCreateCart'],
  useAddItem: useAddRestoreItem as RestoreCartHooks['useAddItem'],
  useRemoveItem: useRemoveRestoreItem as RestoreCartHooks['useRemoveItem'],
  useExecuteCart: useExecuteRestoreCart as RestoreCartHooks['useExecuteCart'],
  useRollbackCart: useRollbackRestoreCart as NonNullable<RestoreCartHooks['useRollbackCart']>,
  useBrowseConfigTables: useBrowseConfigTables as RestoreCartHooks['useBrowseConfigTables'],
  useBrowseDeployments: useBrowseDeployments as RestoreCartHooks['useBrowseDeployments'],
  useBrowseDomains: useBrowseDomains as RestoreCartHooks['useBrowseDomains'],
  useBrowseMailboxes: useBrowseMailboxes as RestoreCartHooks['useBrowseMailboxes'],
  useBrowseFiles: useBrowseFiles as RestoreCartHooks['useBrowseFiles'],
};

export default function RestoreCartPage() {
  const [params, setParams] = useSearchParams();

  return (
    <RestoreCartLayout
      hooks={adminHooks}
      bundleId={params.get('bundleId')}
      tenantId={params.get('tenantId')}
      cartId={params.get('cartId')}
      showRollback
      onCartCreated={(id) => {
        const next = new URLSearchParams(params);
        next.set('cartId', id);
        setParams(next, { replace: true });
      }}
    />
  );
}
