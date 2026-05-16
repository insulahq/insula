import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateSftpUserInput,
  UpdateSftpUserInput,
  RotateSftpPasswordInput,
  SftpUserResponse,
  SftpConnectionInfo,
  SftpAuditLogEntry,
} from '@k8s-hosting/api-contracts';

export type SftpUser = SftpUserResponse & {
  linkedSshKeys?: Array<{ id: string; name: string }>;
};

interface SftpUsersResponse { readonly data: readonly SftpUser[] }
interface SftpUserEnvelope { readonly data: SftpUser & { password?: string } }
interface ConnectionInfoEnvelope { readonly data: SftpConnectionInfo }
interface AuditLogResponse { readonly data: readonly SftpAuditLogEntry[] }
interface PasswordEnvelope { readonly data: { password: string } }

export function useSftpUsers(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['sftp-users', tenantId],
    queryFn: () => apiFetch<SftpUsersResponse>(`/api/v1/tenants/${tenantId}/sftp-users`),
    enabled: Boolean(tenantId),
  });
}

export function useCreateSftpUser(tenantId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSftpUserInput) =>
      apiFetch<SftpUserEnvelope>(`/api/v1/tenants/${tenantId}/sftp-users`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sftp-users', tenantId] }); },
  });
}

export function useUpdateSftpUser(tenantId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: UpdateSftpUserInput }) =>
      apiFetch<SftpUserEnvelope>(`/api/v1/tenants/${tenantId}/sftp-users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sftp-users', tenantId] }); },
  });
}

export function useDeleteSftpUser(tenantId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/api/v1/tenants/${tenantId}/sftp-users/${userId}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sftp-users', tenantId] }); },
  });
}

export function useRotateSftpPassword(tenantId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input?: RotateSftpPasswordInput }) =>
      apiFetch<PasswordEnvelope>(`/api/v1/tenants/${tenantId}/sftp-users/${userId}/rotate-password`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sftp-users', tenantId] }); },
  });
}

export function useSftpConnectionInfo(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['sftp-connection-info', tenantId],
    queryFn: () => apiFetch<ConnectionInfoEnvelope>(`/api/v1/tenants/${tenantId}/sftp-users/connection-info`),
    enabled: Boolean(tenantId),
  });
}

export function useSftpAuditLog(tenantId: string | undefined, limit = 50, offset = 0) {
  return useQuery({
    queryKey: ['sftp-audit', tenantId, limit, offset],
    queryFn: () => apiFetch<AuditLogResponse>(`/api/v1/tenants/${tenantId}/sftp-audit?limit=${limit}&offset=${offset}`),
    enabled: Boolean(tenantId),
  });
}
