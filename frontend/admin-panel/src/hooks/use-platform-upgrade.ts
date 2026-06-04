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

interface PostflightResponse {
  readonly data: {
    readonly phase: 'idle' | 'reconciling' | 'healthy';
    readonly verdict: 'idle' | 'healthy' | 'reconciling' | 'abort-recommended';
    readonly consecutiveFailures: number;
    readonly abortThreshold: number;
    readonly pendingVersion: string | null;
    readonly runningVersion: string;
    readonly gates: UpgradeGate[];
    readonly ok: boolean;
    readonly failures: number;
    readonly warnings: number;
    readonly lastCheckedAt: string | null;
    readonly environment: string;
  };
}

export type PostflightData = PostflightResponse['data'];

/**
 * Read-only post-flight convergence state (super_admin). The streak is advanced
 * by the backend reconciler on its own cadence — this is a pure read, so polling
 * it never inflates the streak. Polls while reconciling, OR while an upgrade is
 * pending (so the panel auto-appears once the reconciler produces its first state
 * after an Apply, without a page reload).
 */
export function usePostflight(pollWhilePending = false) {
  return useQuery({
    queryKey: ['upgrade-postflight'],
    queryFn: () => apiFetch<PostflightResponse>('/api/v1/admin/platform/upgrade/postflight'),
    refetchInterval: (query) =>
      query.state.data?.data.phase === 'reconciling' ? 15 * 1000 : pollWhilePending ? 30 * 1000 : false,
    staleTime: 10 * 1000,
  });
}

interface HostMigrationsPreviewResponse {
  readonly data: {
    readonly mode: 'observe' | 'enforce' | 'absent' | 'unknown';
    readonly willRun: boolean;
    readonly note: string;
  };
}

export type HostMigrationsPreviewData = HostMigrationsPreviewResponse['data'];

/** Whether host-migrations would run during an upgrade (host-migrations-desired CM mode). */
export function useHostMigrationsPreview(enabled = true) {
  return useQuery({
    queryKey: ['upgrade-host-migrations'],
    queryFn: () => apiFetch<HostMigrationsPreviewResponse>('/api/v1/admin/platform/upgrade/host-migrations'),
    enabled,
    staleTime: 60 * 1000,
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
      queryClient.invalidateQueries({ queryKey: ['upgrade-postflight'] });
    },
  });
}

interface RollbackResponse {
  readonly data: {
    readonly ok: boolean;
    readonly dataRestored: boolean;
    readonly reason: string | null;
    readonly summary: string;
    readonly manifest: { readonly toVersion: string; readonly previousRef: Record<string, string>; readonly rescueSnapshots: number } | null;
  };
}

export type RollbackData = RollbackResponse['data'];

/**
 * Roll back the most recent upgrade. apply:false = dry-run preview;
 * restoreData:true ALSO reverts the Longhorn rescue snapshots (destructive).
 */
export function useRollback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { apply: boolean; restoreData: boolean }) =>
      apiFetch<RollbackResponse>('/api/v1/admin/platform/rollback', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform-version'] }),
  });
}
