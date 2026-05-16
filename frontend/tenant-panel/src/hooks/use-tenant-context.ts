import { useAuth } from '@/hooks/use-auth';

/**
 * Returns the current tenant context from the authenticated user's JWT claims.
 * Client panel users have a tenantId in their token.
 */
export function useTenantContext() {
  const { user, isLoading } = useAuth();

  return {
    tenantId: user?.tenantId ?? null,
    tenantName: user?.fullName ?? null,
    isLoading,
  };
}
