import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateSubUserInput,
  CreatedSubUser,
  ResetSubUserPasswordResponse,
  SubUser,
  SubUserRole,
  UpdateSubUserInput,
} from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

export type {
  SubUser,
  CreateSubUserInput,
  CreatedSubUser,
  ResetSubUserPasswordResponse,
  SubUserRole,
  UpdateSubUserInput,
} from '@insula/api-contracts';

export function useSubUsers(tenantId: string | null) {
  return useQuery({
    queryKey: ['sub-users', tenantId],
    queryFn: () => apiFetch<{ data: readonly SubUser[] }>(`/api/v1/tenants/${tenantId}/users`),
    enabled: Boolean(tenantId),
  });
}

/**
 * Create a team member. The password is NOT part of the input — the
 * server generates one and returns it in `data.generatedPassword`.
 * That response is the only time it is ever available, so the caller
 * must surface it to the operator.
 */
export function useCreateSubUser(tenantId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSubUserInput) =>
      apiFetch<{ data: CreatedSubUser }>(`/api/v1/tenants/${tenantId}/users`, {
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
 * Admin-assisted password reset. Takes no password: the server
 * regenerates one and returns it in `data.password`. The calling
 * tenant_admin communicates it out-of-band — no email is sent.
 *
 * Sent with no request body at all, which `apiFetch` turns into a
 * POST with no Content-Type. The route normalises that to `{}`.
 */
export function useResetSubUserPassword(tenantId: string | null) {
  return useMutation({
    mutationFn: ({ userId }: { userId: string }) =>
      apiFetch<{ data: ResetSubUserPasswordResponse }>(
        `/api/v1/tenants/${tenantId}/users/${userId}/reset-password`,
        { method: 'POST' },
      ),
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
