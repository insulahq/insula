import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { ProtectedDirectoryResponse, ProtectedDirectoryUserResponse } from '@/types/api';

function basePath(tenantId: string, domainId: string) {
  return `/api/v1/tenants/${tenantId}/domains/${domainId}/protected-directories`;
}

// ─── Directory CRUD ──────────────────────────────────────────────────────────

export function useProtectedDirectories(tenantId: string | undefined, domainId: string | undefined) {
  return useQuery({
    queryKey: ['protected-directories', tenantId, domainId],
    queryFn: () =>
      apiFetch<{ data: readonly ProtectedDirectoryResponse[] }>(basePath(tenantId!, domainId!)),
    enabled: Boolean(tenantId && domainId),
  });
}

interface CreateDirectoryInput {
  readonly path: string;
  readonly realm?: string;
}

export function useCreateProtectedDirectory(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateDirectoryInput) =>
      apiFetch<{ data: ProtectedDirectoryResponse }>(basePath(tenantId!, domainId!), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['protected-directories', tenantId, domainId] });
    },
  });
}

export function useDeleteProtectedDirectory(tenantId: string | undefined, domainId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (dirId: string) =>
      apiFetch<void>(`${basePath(tenantId!, domainId!)}/${dirId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['protected-directories', tenantId, domainId] });
    },
  });
}

// ─── Directory Users ─────────────────────────────────────────────────────────

export function useDirectoryUsers(
  tenantId: string | undefined,
  domainId: string | undefined,
  dirId: string | undefined,
) {
  return useQuery({
    queryKey: ['directory-users', tenantId, domainId, dirId],
    queryFn: () =>
      apiFetch<{ data: readonly ProtectedDirectoryUserResponse[] }>(
        `${basePath(tenantId!, domainId!)}/${dirId}/users`,
      ),
    enabled: Boolean(tenantId && domainId && dirId),
  });
}

interface CreateDirectoryUserInput {
  readonly username: string;
  readonly password: string;
}

export function useCreateDirectoryUser(
  tenantId: string | undefined,
  domainId: string | undefined,
  dirId: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateDirectoryUserInput) =>
      apiFetch<{ data: ProtectedDirectoryUserResponse }>(
        `${basePath(tenantId!, domainId!)}/${dirId}/users`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['directory-users', tenantId, domainId, dirId] });
    },
  });
}

export function useDisableDirectoryUser(
  tenantId: string | undefined,
  domainId: string | undefined,
  dirId: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<{ data: { message: string } }>(
        `${basePath(tenantId!, domainId!)}/${dirId}/users/${userId}/disable`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['directory-users', tenantId, domainId, dirId] });
    },
  });
}

export function useDeleteDirectoryUser(
  tenantId: string | undefined,
  domainId: string | undefined,
  dirId: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`${basePath(tenantId!, domainId!)}/${dirId}/users/${userId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['directory-users', tenantId, domainId, dirId] });
    },
  });
}
