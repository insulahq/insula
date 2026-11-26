import { useCallback, useEffect, useState } from 'react';
import { useDeploymentCredentials } from '@/hooks/use-deployments';

/**
 * How long the panel keeps asking before it says the administrator account is
 * taking longer than it should. Setting it up takes seconds; an instance the
 * platform cannot log in to (the admin's "Platform lost its login to a tenant
 * database") never gets one until it is repaired, and every read of the
 * credentials asks the platform to try again — so the asking has to stop.
 */
export const ADMIN_ACCOUNT_PENDING_WAIT_MS = 120_000;

/**
 * The credentials of a database instance, re-read while its administrator
 * account is being set up — for at most ADMIN_ACCOUNT_PENDING_WAIT_MS. After
 * that `adminSetupSlow` is true and the panel offers `checkAgain`, which asks
 * once and starts a new wait.
 *
 * `canWait`: the instance runs a managed engine and is running, so an account
 * is coming. Otherwise there is nothing to wait for.
 */
export function useCredentialsAwaitingAdmin(
  tenantId: string | undefined,
  deploymentId: string | undefined,
  canWait: boolean,
) {
  const [expired, setExpired] = useState(false);
  const [round, setRound] = useState(0);
  const query = useDeploymentCredentials(tenantId, deploymentId, { pollWhileAdminPending: canWait && !expired });
  // Only `pending` is worth waiting for: `restricted`, `unavailable` and
  // `lost` do not change by asking again.
  const pending = canWait && query.data?.data?.adminAccountStatus === 'pending';

  useEffect(() => {
    setExpired(false);
    if (!pending) return undefined;
    const timer = setTimeout(() => setExpired(true), ADMIN_ACCOUNT_PENDING_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending, round]);

  const { refetch } = query;
  const checkAgain = useCallback(() => {
    setRound((r) => r + 1);
    void refetch();
  }, [refetch]);

  return { query, adminSetupSlow: pending && expired, checkAgain };
}
