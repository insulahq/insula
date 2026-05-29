import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreatePrivateWorkerInput,
  PrivateWorkerResponse,
  PrivateWorkerSecretResponse,
  PrivateWorkerListResponse,
  PrivateWorkerAuditListResponse,
} from '@insula/api-contracts';

// All envelopes follow the platform `{ data, error }` convention. The
// list / audit endpoints already return their own `{ items: [...] }`
// shape inside `data`, mirroring how the backend service layer wraps
// arrays elsewhere.

interface PrivateWorkerListEnvelope {
  readonly data: PrivateWorkerListResponse;
}

interface PrivateWorkerEnvelope {
  readonly data: PrivateWorkerResponse;
}

interface PrivateWorkerSecretEnvelope {
  readonly data: PrivateWorkerSecretResponse;
}

interface PrivateWorkerAuditEnvelope {
  readonly data: PrivateWorkerAuditListResponse;
}

export function usePrivateWorkers(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['private-workers', tenantId],
    queryFn: () =>
      apiFetch<PrivateWorkerListEnvelope>(
        `/api/v1/tenants/${tenantId}/private-workers`,
      ),
    enabled: Boolean(tenantId),
  });
}

export function usePrivateWorker(
  tenantId: string | undefined,
  workerId: string | undefined,
) {
  return useQuery({
    queryKey: ['private-workers', tenantId, workerId],
    queryFn: () =>
      apiFetch<PrivateWorkerEnvelope>(
        `/api/v1/tenants/${tenantId}/private-workers/${workerId}`,
      ),
    enabled: Boolean(tenantId) && Boolean(workerId),
  });
}

export function usePrivateWorkerAudit(
  tenantId: string | undefined,
  workerId: string | undefined,
  limit = 50,
) {
  return useQuery({
    queryKey: ['private-workers', tenantId, workerId, 'audit', limit],
    queryFn: () =>
      apiFetch<PrivateWorkerAuditEnvelope>(
        `/api/v1/tenants/${tenantId}/private-workers/${workerId}/audit?limit=${limit}`,
      ),
    enabled: Boolean(tenantId) && Boolean(workerId),
  });
}

export function useCreatePrivateWorker(tenantId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePrivateWorkerInput) =>
      apiFetch<PrivateWorkerSecretEnvelope>(
        `/api/v1/tenants/${tenantId}/private-workers`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['private-workers', tenantId] });
    },
  });
}

export function useRotatePrivateWorker(tenantId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) =>
      apiFetch<PrivateWorkerSecretEnvelope>(
        `/api/v1/tenants/${tenantId}/private-workers/${workerId}/rotate`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      ),
    onSuccess: (_data, workerId) => {
      qc.invalidateQueries({ queryKey: ['private-workers', tenantId] });
      qc.invalidateQueries({ queryKey: ['private-workers', tenantId, workerId] });
    },
  });
}

export function useRevokePrivateWorker(tenantId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) =>
      apiFetch<PrivateWorkerEnvelope>(
        `/api/v1/tenants/${tenantId}/private-workers/${workerId}/revoke`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      ),
    onSuccess: (_data, workerId) => {
      qc.invalidateQueries({ queryKey: ['private-workers', tenantId] });
      qc.invalidateQueries({ queryKey: ['private-workers', tenantId, workerId] });
    },
  });
}

export function useDeletePrivateWorker(tenantId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workerId: string) =>
      apiFetch<void>(
        `/api/v1/tenants/${tenantId}/private-workers/${workerId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['private-workers', tenantId] });
    },
  });
}
