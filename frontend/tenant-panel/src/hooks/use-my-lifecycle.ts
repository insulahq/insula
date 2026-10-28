import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * My lifecycle state — what's the owning tenant's status + storage op?
 *
 * Polls /api/v1/auth/me so the banner reacts quickly when an admin takes
 * action (suspend / resize / archive) from the other panel. Server-side the
 * query reads `tenants.status` + `.storage_lifecycle_state` via the
 * already-authenticated user, no extra auth gate needed.
 */

// Enum and notice types come from the shared contracts package so a change
// to `statusEnum`, `storageLifecycleStateEnum` or the notice flows through
// without silent drift in this hook.
import type { TenantStatus, StorageLifecycleState, TenantStorageNotice } from '@insula/api-contracts';
export type { TenantStatus, StorageLifecycleState, TenantStorageNotice };

export interface MyLifecycleInfo {
  readonly tenantStatus: TenantStatus | null;
  readonly storageLifecycleState: StorageLifecycleState | null;
  readonly tenantId: string | null;
  /** The storage operation behind a non-idle state, when there is one. */
  readonly activeStorageOperation: { readonly id: string; readonly isSnapshotRestore: boolean } | null;
  /**
   * What the banner says about storage, decided by the server. `undefined`
   * only from an API that predates it — the banner then falls back to the
   * bare state; `null` means there is nothing to say.
   */
  readonly storageNotice?: TenantStorageNotice | null;
}

interface AuthMeResponse {
  readonly data: {
    readonly id: string;
    readonly tenantId: string | null;
    readonly tenantStatus?: TenantStatus | null;
    readonly storageLifecycleState?: StorageLifecycleState | null;
    readonly activeStorageOperation?: { readonly id: string; readonly isSnapshotRestore: boolean } | null;
    readonly storageNotice?: TenantStorageNotice | null;
  };
}

/**
 * Fast polling only while an operation RUNS. `failed` is a resting state —
 * it changes when an operator acts or the workloads come back, not within
 * seconds — and polling it every 3 s kept every open tab hammering the API
 * for as long as a tenant stayed failed.
 */
export function lifecyclePollMs(state: StorageLifecycleState | null | undefined, status: TenantStatus | null | undefined): number {
  if (state && state !== 'idle' && state !== 'failed') return 3000;
  if (status === 'suspended' || status === 'archived') return 10000;
  return 30000;
}

export function useMyLifecycle(): { readonly data: MyLifecycleInfo | null; readonly isLoading: boolean } {
  const q = useQuery({
    queryKey: ['me-lifecycle'],
    queryFn: () => apiFetch<AuthMeResponse>('/api/v1/auth/me'),
    refetchInterval: (query) => lifecyclePollMs(
      query.state.data?.data?.storageLifecycleState,
      query.state.data?.data?.tenantStatus,
    ),
  });

  return {
    isLoading: q.isLoading,
    data: q.data
      ? {
          tenantStatus: q.data.data.tenantStatus ?? null,
          storageLifecycleState: q.data.data.storageLifecycleState ?? null,
          tenantId: q.data.data.tenantId,
          activeStorageOperation: q.data.data.activeStorageOperation ?? null,
          storageNotice: q.data.data.storageNotice,
        }
      : null,
  };
}
