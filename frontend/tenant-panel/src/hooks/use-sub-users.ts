import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateSubUserInput,
  SubUser,
  SubUserRole,
  UpdateSubUserInput,
} from '@k8s-hosting/api-contracts';
import { apiFetch } from '@/lib/api-client';

export type {
  SubUser,
  CreateSubUserInput,
  SubUserRole,
  UpdateSubUserInput,
} from '@k8s-hosting/api-contracts';

export function useSubUsers(tenantId: string | null) {
  return useQuery({
    queryKey: ['sub-users', tenantId],
    queryFn: () => apiFetch<{ data: readonly SubUser[] }>(`/api/v1/tenants/${tenantId}/users`),
    enabled: Boolean(tenantId),
  });
}

export function useCreateSubUser(tenantId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSubUserInput) =>
      apiFetch<{ data: SubUser }>(`/api/v1/tenants/${tenantId}/users`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sub-users', tenantId] }); },
  });
}

/**
 * Phase 3: edit a sub-user's name, role, or status. Password
 * changes go through `useResetSubUserPassword` in Phase 4.
 */
export function useUpdateSubUser(tenantId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, patch }: { userId: string; patch: UpdateSubUserInput }) =>
      apiFetch<{ data: SubUser }>(`/api/v1/tenants/${tenantId}/users/${userId}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sub-users', tenantId] }); },
  });
}

/**
 * Phase 4: admin-assisted password reset. The calling tenant_admin
 * sets a new password for a teammate and is responsible for
 * communicating it out-of-band. No email is sent.
 */
export function useResetSubUserPassword(tenantId: string | null) {
  return useMutation({
    mutationFn: ({ userId, newPassword }: { userId: string; newPassword: string }) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/users/${userId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ new_password: newPassword }),
      }),
  });
}

export function useDeleteSubUser(tenantId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/users/${userId}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sub-users', tenantId] }); },
  });
}
