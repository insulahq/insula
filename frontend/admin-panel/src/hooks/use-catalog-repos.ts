import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CatalogRepoSettingsResponse, CreateCatalogRepoRequest } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

export interface CatalogRepo {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly branch: string;
  /** Synced once a day while on. */
  readonly autoSyncEnabled: boolean;
  readonly lastSyncedAt: string | null;
  readonly status: 'active' | 'error' | 'syncing';
  readonly lastError: string | null;
  readonly createdAt: string;
}

interface CatalogReposResponse {
  readonly data: readonly CatalogRepo[];
}

/** Shared contract — createCatalogRepoSchema is what the backend parses with. */
type AddCatalogRepoInput = CreateCatalogRepoRequest;

export function useCatalogRepos() {
  return useQuery({
    queryKey: ['catalog-repos'],
    queryFn: () => apiFetch<CatalogReposResponse>('/api/v1/admin/catalog-repos'),
    staleTime: 60_000,
  });
}

export function useRestoreDefaultCatalogRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: CatalogRepo }>('/api/v1/admin/catalog-repos/restore-default', {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog-repos'] });
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
  });
}

export function useAddCatalogRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AddCatalogRepoInput) =>
      apiFetch<{ data: CatalogRepo }>('/api/v1/admin/catalog-repos', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog-repos'] });
    },
  });
}

export function useDeleteCatalogRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/catalog-repos/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog-repos'] });
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
  });
}

export function useSyncCatalogRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: CatalogRepo }>(`/api/v1/admin/catalog-repos/${id}/sync`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog-repos'] });
      queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
  });
}

export function useSetCatalogRepoAutoSync() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, enabled }: { readonly id: string; readonly enabled: boolean }) =>
      apiFetch<{ data: CatalogRepo }>(`/api/v1/admin/catalog-repos/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ auto_sync_enabled: enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog-repos'] });
    },
  });
}

/** Applications → Repositories settings: may repository URLs reach private networks. */
export function useCatalogRepoSettings() {
  return useQuery({
    queryKey: ['catalog-repos', 'settings'],
    queryFn: () => apiFetch<{ data: CatalogRepoSettingsResponse }>('/api/v1/admin/catalog-repos/settings'),
    staleTime: 60_000,
  });
}

export function useSetCatalogRepoSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (allowPrivateAddresses: boolean) =>
      apiFetch<{ data: CatalogRepoSettingsResponse }>('/api/v1/admin/catalog-repos/settings', {
        method: 'PUT',
        body: JSON.stringify({ allow_private_addresses: allowPrivateAddresses }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog-repos', 'settings'] });
    },
  });
}
