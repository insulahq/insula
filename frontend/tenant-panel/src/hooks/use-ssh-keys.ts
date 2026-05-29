/**
 * Round-4 Phase B: tenant-panel SSH keys management hooks.
 *
 * Backend routes live at
 *   GET    /api/v1/tenants/:tenantId/ssh-keys
 *   POST   /api/v1/tenants/:tenantId/ssh-keys
 *   DELETE /api/v1/tenants/:tenantId/ssh-keys/:keyId
 * and are accessible to tenant_admin + tenant_user roles.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { CreateSshKeyInput, UpdateSshKeyInput, SshKeyResponse } from '@insula/api-contracts';

export type SshKey = SshKeyResponse;

interface SshKeysResponse {
  readonly data: readonly SshKey[];
}

interface SshKeyResponseEnvelope {
  readonly data: SshKey;
}

export function useSshKeys(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['ssh-keys', tenantId],
    queryFn: () => apiFetch<SshKeysResponse>(`/api/v1/tenants/${tenantId}/ssh-keys`),
    enabled: Boolean(tenantId),
  });
}

export function useCreateSshKey(tenantId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSshKeyInput) =>
      apiFetch<SshKeyResponseEnvelope>(
        `/api/v1/tenants/${tenantId}/ssh-keys`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ssh-keys', tenantId] });
    },
  });
}

export function useUpdateSshKey(tenantId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ keyId, input }: { keyId: string; input: UpdateSshKeyInput }) =>
      apiFetch<SshKeyResponseEnvelope>(
        `/api/v1/tenants/${tenantId}/ssh-keys/${keyId}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ssh-keys', tenantId] });
    },
  });
}

export function useDeleteSshKey(tenantId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      apiFetch<void>(
        `/api/v1/tenants/${tenantId}/ssh-keys/${keyId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ssh-keys', tenantId] });
    },
  });
}
