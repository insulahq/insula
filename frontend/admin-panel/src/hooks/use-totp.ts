/**
 * The signed-in user's authenticator-app second factor (TOTP).
 * Types come from @insula/api-contracts; the rules live in the backend's
 * totp-service.ts (enrolment confirmed by a code, codes used once, backup
 * codes shown once).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TotpBackupCodesResponse, TotpSetupResponse, TotpStatus } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

/** A live code from the app, or one backup code. */
export type TotpProofInput = { readonly code: string } | { readonly backup_code: string };

const STATUS_KEY = ['totp-status'] as const;

export function useTotpStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => apiFetch<{ data: TotpStatus }>('/api/v1/auth/totp').then((r) => r.data),
  });
}

/** Start (or restart) enrolment: a fresh secret, shown once. */
export function useTotpSetup() {
  return useMutation({
    mutationFn: () => apiFetch<{ data: TotpSetupResponse }>('/api/v1/auth/totp/setup', { method: 'POST' }).then((r) => r.data),
  });
}

/** Confirm with a code from the app; resolves to the backup codes. */
export function useTotpEnable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => apiFetch<{ data: TotpBackupCodesResponse }>('/api/v1/auth/totp/enable', {
      method: 'POST', body: JSON.stringify({ code }),
    }).then((r) => r.data.backupCodes),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  });
}

export function useTotpDisable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proof: TotpProofInput) => apiFetch('/api/v1/auth/totp/disable', {
      method: 'POST', body: JSON.stringify(proof),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  });
}

/** New backup codes; the old ones stop working. */
export function useTotpRegenerateBackupCodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proof: TotpProofInput) => apiFetch<{ data: TotpBackupCodesResponse }>('/api/v1/auth/totp/backup-codes', {
      method: 'POST', body: JSON.stringify(proof),
    }).then((r) => r.data.backupCodes),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  });
}
