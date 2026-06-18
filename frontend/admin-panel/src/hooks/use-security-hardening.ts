/**
 * TanStack Query hooks for the security-hardening admin API.
 *
 *   GET  /admin/security-hardening          → full snapshot envelope
 *   POST /admin/security-hardening/refresh  → bump probe DaemonSet
 *
 * 30s refetch — slow enough to not hammer kube-API, fast enough for
 * the operator to see probe writes after acting on the runbook.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  SecurityHardeningResponse,
  RefreshSecurityHardeningResponse,
  ListNetworkPolicyTemplatesResponse,
  ApplyNetworkPolicyTemplateRequest,
  ApplyNetworkPolicyTemplateResponse,
  RemoveNetworkPolicyHardeningRequest,
  RemoveNetworkPolicyHardeningResponse,
  OperatorTrustStatus,
  AddOperatorTrustResponse,
} from '@insula/api-contracts';

interface Envelope<T> {
  readonly data: T;
}

const SNAPSHOT_KEY = ['security-hardening', 'snapshot'] as const;

export function useSecurityHardeningSnapshot() {
  return useQuery<SecurityHardeningResponse>({
    queryKey: SNAPSHOT_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security-hardening'),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function useRefreshSecurityHardening() {
  const qc = useQueryClient();
  return useMutation<Envelope<RefreshSecurityHardeningResponse>, Error, void>({
    mutationFn: () =>
      apiFetch('/api/v1/admin/security-hardening/refresh', { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SNAPSHOT_KEY });
    },
  });
}

// ─── NetworkPolicy hardening templates (R11 / Phase 2.4.1) ───────────────
const NETPOL_KEY = ['security-hardening', 'netpol-templates'] as const;

/** Catalog + current coverage + opted-out namespaces. */
export function useNetworkPolicyHardening() {
  return useQuery<ListNetworkPolicyTemplatesResponse>({
    queryKey: NETPOL_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security/netpol-templates'),
    staleTime: 15_000,
  });
}

/** Apply a template (apply:false = dry-run preview). */
export function useApplyNetworkPolicyTemplate() {
  const qc = useQueryClient();
  return useMutation<ApplyNetworkPolicyTemplateResponse, Error, ApplyNetworkPolicyTemplateRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/netpol-templates/apply', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (res) => { if (!res.dryRun) void qc.invalidateQueries({ queryKey: NETPOL_KEY }); },
  });
}

/** Remove the platform-managed hardening policy (apply:false = dry-run preview). */
export function useRemoveNetworkPolicyHardening() {
  const qc = useQueryClient();
  return useMutation<RemoveNetworkPolicyHardeningResponse, Error, RemoveNetworkPolicyHardeningRequest>({
    mutationFn: (body) =>
      apiFetch('/api/v1/admin/security/netpol-templates/remove', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (res) => { if (!res.dryRun) void qc.invalidateQueries({ queryKey: NETPOL_KEY }); },
  });
}

// ─── Operator → trusted-range bridge (R11 / Phase 2.3.1) ─────────────────
const OPERATOR_TRUST_KEY = ['security-hardening', 'operator-trust'] as const;

/** Whether the operator's current connection IP is in a trusted range. */
export function useOperatorTrust() {
  return useQuery<OperatorTrustStatus>({
    queryKey: OPERATOR_TRUST_KEY,
    queryFn: () => apiFetch('/api/v1/admin/security/operator-trust'),
    staleTime: 15_000,
  });
}

/** One-click add of the operator's own current IP to trusted ranges. */
export function useAddOperatorTrust() {
  const qc = useQueryClient();
  return useMutation<AddOperatorTrustResponse, Error, void>({
    mutationFn: () => apiFetch('/api/v1/admin/security/operator-trust/add', { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: OPERATOR_TRUST_KEY });
      void qc.invalidateQueries({ queryKey: SNAPSHOT_KEY });
    },
  });
}
