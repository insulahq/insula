import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateSubUserInput,
  SubUser,
  SubUserRole,
  UpdateSubUserInput,
} from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

export type {
  SubUser,
  CreateSubUserInput,
  SubUserRole,
  UpdateSubUserInput,
} from '@insula/api-contracts';

/**
 * Phase 5: admin panel hooks for managing a specific tenant's
 * sub-users. The backend routes are the same as the tenant panel
 * (`/api/v1/tenants/:tenantId/users*`) — the admin panel just
 * supplies its own JWT (super_admin / admin) which has staff role
 * requirements.
 */

/**
 * Only the read query accepts `string | null` — it translates
 * cleanly to a disabled TanStack Query. The mutation hooks demand
 * a non-null `string` because mutations have no disabled-state
 * equivalent: a null tenantId would produce a request to
 * `/api/v1/tenants/null/users` which the route matcher would
 * happily accept before failing downstream with a misleading
 * error.
 */
export function useAdminSubUsers(tenantId: string | null) {
  return useQuery({
    queryKey: ['admin', 'sub-users', tenantId],
    queryFn: () =>
      apiFetch<{ data: readonly SubUser[] }>(`/api/v1/tenants/${tenantId}/users`),
    enabled: Boolean(tenantId),
  });
}

export function useAdminCreateSubUser(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSubUserInput) =>
      apiFetch<{ data: SubUser }>(`/api/v1/tenants/${tenantId}/users`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'sub-users', tenantId] });
    },
  });
}

export function useAdminUpdateSubUser(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, patch }: { userId: string; patch: UpdateSubUserInput }) =>
      apiFetch<{ data: SubUser }>(`/api/v1/tenants/${tenantId}/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'sub-users', tenantId] });
    },
  });
}

export function useAdminResetSubUserPassword(tenantId: string) {
  return useMutation({
    mutationFn: ({ userId, newPassword }: { userId: string; newPassword: string }) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/users/${userId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ new_password: newPassword }),
      }),
  });
}

export function useAdminDeleteSubUser(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/users/${userId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'sub-users', tenantId] });
    },
  });
}
