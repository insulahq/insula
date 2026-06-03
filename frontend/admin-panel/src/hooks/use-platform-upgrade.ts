import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface UpgradeGate {
  readonly id: string;
  readonly label: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail: string;
}

interface PreflightResponse {
  readonly data: {
    readonly gates: UpgradeGate[];
    readonly ok: boolean;
    readonly failures: number;
    readonly warnings: number;
    readonly environment: string;
  };
}

export type PreflightData = PreflightResponse['data'];

/** Read-only upgrade pre-flight gate evaluation (super_admin). */
export function usePreflight(enabled = true) {
  return useQuery({
    queryKey: ['upgrade-preflight'],
    queryFn: () => apiFetch<PreflightResponse>('/api/v1/admin/platform/upgrade/preflight'),
    enabled,
    staleTime: 30 * 1000,
  });
}

interface UpgradeApplyResponse {
  readonly data: {
    readonly action: string;
    readonly target: string | null;
    readonly reason: string;
    readonly proceed: boolean;
    readonly applied: boolean;
    readonly gitRepository: string | null;
    readonly environment: string;
    readonly summary: string;
  };
}

export type UpgradeApplyData = UpgradeApplyResponse['data'];

/**
 * Plan (apply:false → dry-run preview) or apply (apply:true → Flux re-pin) a
 * platform upgrade. An apply is server-side gated on pre-flight passing (409).
 */
export function useUpgradeApply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { version?: string; apply: boolean }) =>
      apiFetch<UpgradeApplyResponse>('/api/v1/admin/platform/upgrade', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-version'] });
      queryClient.invalidateQueries({ queryKey: ['upgrade-preflight'] });
    },
  });
}
