import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * My lifecycle state — what's the owning tenant's status + storage op?
 *
 * Polls /api/v1/auth/me every 10s so the banner reacts quickly when an
 * admin takes action (suspend / resize / archive) from the other panel.
 * Server-side the query reads `tenants.status` + `.storage_lifecycle_state`
 * via the already-authenticated user, no extra auth gate needed.
 */

// Enum types come from the shared contracts package so a change to
// `statusEnum` or `storageLifecycleStateEnum` flows through without
// silent drift in this hook.
import type { TenantStatus, StorageLifecycleState } from '@k8s-hosting/api-contracts';
export type { TenantStatus, StorageLifecycleState };

export interface MyLifecycleInfo {
  readonly tenantStatus: TenantStatus | null;
  readonly storageLifecycleState: StorageLifecycleState | null;
  readonly tenantId: string | null;
}

interface AuthMeResponse {
  readonly data: {
    readonly id: string;
    readonly tenantId: string | null;
    readonly tenantStatus?: TenantStatus | null;
    readonly storageLifecycleState?: StorageLifecycleState | null;
  };
}

export function useMyLifecycle(): { readonly data: MyLifecycleInfo | null; readonly isLoading: boolean } {
  const q = useQuery({
    queryKey: ['me-lifecycle'],
    queryFn: () => apiFetch<AuthMeResponse>('/api/v1/auth/me'),
    // Poll faster while an op is in flight; slow down when idle so the
    // banner doesn't hammer the API in normal usage.
    refetchInterval: (query) => {
      const state = query.state.data?.data?.storageLifecycleState;
      const status = query.state.data?.data?.tenantStatus;
      if (state && state !== 'idle') return 3000;
      if (status === 'suspended' || status === 'archived') return 10000;
      return 30000;
    },
  });

  return {
    isLoading: q.isLoading,
    data: q.data
      ? {
          tenantStatus: q.data.data.tenantStatus ?? null,
          storageLifecycleState: q.data.data.storageLifecycleState ?? null,
          tenantId: q.data.data.tenantId,
        }
      : null,
  };
}
