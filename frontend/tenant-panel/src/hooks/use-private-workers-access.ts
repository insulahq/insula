import { useSubscription } from '@/hooks/use-subscription';
import { usePrivateWorkers } from '@/hooks/use-private-workers';

export interface PrivateWorkersAccess {
  /** The subscription has answered (or failed), so `canCreate` is no longer a placeholder. */
  readonly known: boolean;
  /** New private workers may be created: "Allow Custom Containers" is in effect. */
  readonly canCreate: boolean;
  /** The page belongs in the navigation. */
  readonly listed: boolean;
  /**
   * `listed` is final: the subscription has answered and, when it says no,
   * so has the worker list. Before that `listed` reads false for a tenant
   * that will turn out to have the tab — a deep link must wait for this
   * rather than fall back to another tab.
   */
  readonly settled: boolean;
}

/**
 * Private workers ride on the custom-container subscription gate (the
 * backend refuses a new one with CUSTOM_CONTAINERS_NOT_IN_PLAN): `canCreate`
 * is the subscription's effective "Allow Custom Containers" — the platform
 * switch AND the plan or per-tenant override.
 *
 * Without it the page is still listed while the tenant HAS workers — ones
 * made before the plan changed keep running, and this page is the only place
 * to rotate, revoke or delete them. The worker list is only fetched for that
 * question when the subscription says no.
 *
 * A subscription that cannot be read opens the panel rather than closing it:
 * hiding the page could strand a tenant's workers, and the API still refuses
 * a create the subscription does not allow.
 */
export function usePrivateWorkersAccess(tenantId: string | undefined): PrivateWorkersAccess {
  const { data: subscription, isError } = useSubscription(tenantId);
  const known = subscription !== undefined || isError;
  const canCreate = isError || (subscription?.data.allowCustomContainers ?? false);
  const { data: workers, isFetched, isError: workersFailed } = usePrivateWorkers(known && !canCreate ? tenantId : undefined);
  const hasWorkers = (workers?.data?.items.length ?? 0) > 0;
  const settled = known && (canCreate || isFetched || workersFailed);
  return { known, canCreate, listed: canCreate || hasWorkers, settled };
}
