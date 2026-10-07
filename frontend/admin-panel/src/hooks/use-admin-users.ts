import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AdminUserListItem } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

/** A row of GET /admin/users — the contract type (sign-in facts included). */
export type AdminUser = AdminUserListItem;

interface AdminUsersResponse {
  readonly data: readonly AdminUser[];
}

interface AdminUserResponse {
  readonly data: AdminUser;
}

export function useAdminUsers() {
  return useQuery({
    queryKey: ['admin-users'],
    queryFn: () => apiFetch<AdminUsersResponse>('/api/v1/admin/users'),
  });
}

export function useCreateAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; full_name: string; password: string; role_name: string }) =>
      apiFetch<AdminUserResponse>('/api/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

export function useUpdateAdminUser(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch<AdminUserResponse>(`/api/v1/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

export function useDeleteAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

/**
 * Remove a user's authenticator-app second factor (admin or tenant user) —
 * for someone who lost both the phone and the backup codes. super_admin only.
 */
export function useResetUserTotp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<{ data: { wasEnabled: boolean } }>(`/api/v1/admin/users/${encodeURIComponent(userId)}/totp`, { method: 'DELETE' })
        .then((r) => r.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      void queryClient.invalidateQueries({ queryKey: ['tenant-users'] });
    },
  });
}
