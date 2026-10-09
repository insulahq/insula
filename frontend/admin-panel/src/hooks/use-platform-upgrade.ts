import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UpgradeGate, UpgradeRun, UpgradeChangesResponse } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';

// The gate shape is the shared contract's (it carries `scheduled`, which a local
// copy silently dropped).
export type { UpgradeGate, UpgradeRun };

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

/**
 * Read-only upgrade pre-flight gate evaluation (super_admin). `exclude` judges the
 * nodes the way an apply that upgrades without them would (ADR-064).
 */
export function usePreflight(enabled = true, exclude: readonly string[] = []) {
  const qs = exclude.length > 0 ? `?exclude=${encodeURIComponent(exclude.join(','))}` : '';
  return useQuery({
    queryKey: ['upgrade-preflight', exclude.join(',')],
    queryFn: () => apiFetch<PreflightResponse>(`/api/v1/admin/platform/upgrade/preflight${qs}`),
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
    refetchIntervalInBackground: true,
    retry: true,
    retryDelay: 2000,
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

export interface AffectedService {
  readonly name: string;
  readonly label: string;
  readonly impact: string;
}

export interface InterruptionPreview {
  readonly services: AffectedService[];
  readonly nodeCount: number | null;
  readonly singleNode: boolean;
  /** No second replica for at least one user-facing service (from the Deployments, not the node count). */
  readonly noRedundancy?: boolean;
  readonly summary: string;
  readonly tenantWorkloadsAffected: boolean;
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
    /** Populated on a dry-run (apply:false) so the confirm modal can preview it. */
    readonly interruption: InterruptionPreview | null;
    /** ADR-064: the run an apply started. */
    readonly runId?: string | null;
  };
}

export type UpgradeApplyData = UpgradeApplyResponse['data'];

export type DeploymentPhase = 'pending' | 'downloading' | 'starting' | 'ready' | 'error';

export interface DeploymentProgress {
  readonly name: string;
  readonly label: string;
  readonly desiredReplicas: number;
  readonly readyReplicas: number;
  readonly imageTag: string | null;
  readonly versionManaged: boolean;
  readonly atTarget: boolean;
  /** Coarse roll phase for this component (optional — older backends omit it). */
  readonly phase?: DeploymentPhase;
}

interface UpgradeProgressResponse {
  readonly data: {
    readonly targetTag: string | null;
    readonly total: number;
    readonly atTarget: number;
    readonly ready: number;
    readonly percent: number;
    readonly readable: boolean;
    readonly deployments: DeploymentProgress[];
  };
}

export type UpgradeProgressData = UpgradeProgressResponse['data'];

/**
 * LIVE per-Deployment upgrade roll progress. Polls every 4s while an upgrade is
 * in flight (the caller passes `active` = a pending version exists) so the bar
 * advances smoothly, and stops when idle.
 */
export function useUpgradeProgress(active: boolean) {
  return useQuery({
    queryKey: ['upgrade-progress'],
    queryFn: () => apiFetch<UpgradeProgressResponse>('/api/v1/admin/platform/upgrade/progress'),
    enabled: active,
    // Keep polling THROUGH the roll — the admin-panel + platform-api pods restart
    // mid-upgrade, so requests fail for ~30–90s. React Query keeps the interval
    // firing on error and retries, so the bar resumes on its own (no page reload).
    refetchInterval: active ? 4 * 1000 : false,
    refetchIntervalInBackground: true,
    retry: true,
    retryDelay: 2000,
    staleTime: 2 * 1000,
  });
}

/**
 * Plan (apply:false → dry-run preview) or apply (apply:true → Flux re-pin) a
 * platform upgrade. An apply is server-side gated on pre-flight passing (409).
 */
export function useUpgradeApply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { version?: string; apply: boolean; excludeNodes?: readonly string[] }) =>
      apiFetch<UpgradeApplyResponse>('/api/v1/admin/platform/upgrade', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-version'] });
      queryClient.invalidateQueries({ queryKey: ['upgrade-preflight'] });
      queryClient.invalidateQueries({ queryKey: ['upgrade-postflight'] });
      queryClient.invalidateQueries({ queryKey: ['upgrade-run'] });
    },
  });
}

interface UpgradeRunResponse {
  readonly data: { readonly run: UpgradeRun | null };
}

/**
 * The upgrade run in flight, else the latest one (ADR-064). Polls every 4 s while
 * it runs — through the services' roll, when the API itself restarts — and stops
 * once it has finished.
 */
export function useUpgradeRun(enabled = true) {
  return useQuery({
    queryKey: ['upgrade-run'],
    queryFn: () => apiFetch<UpgradeRunResponse>('/api/v1/admin/platform/upgrade/run'),
    enabled,
    refetchInterval: (query) => (query.state.data?.data.run?.status === 'running' ? 4 * 1000 : false),
    refetchIntervalInBackground: true,
    retry: true,
    retryDelay: 2000,
    staleTime: 2 * 1000,
  });
}

/** What an upgrade to the available release changes (ADR-064 §6). */
export function useUpgradeChanges(enabled = true) {
  return useQuery({
    queryKey: ['upgrade-changes'],
    queryFn: () => apiFetch<{ readonly data: UpgradeChangesResponse }>('/api/v1/admin/platform/upgrade/changes'),
    enabled,
    staleTime: 30 * 1000,
  });
}

/** One run by id (its page). Polls while it runs. */
export function useUpgradeRunById(id: string | undefined) {
  return useQuery({
    queryKey: ['upgrade-run', id],
    queryFn: () => apiFetch<{ readonly data: UpgradeRun }>(`/api/v1/admin/platform/upgrade/runs/${encodeURIComponent(id ?? '')}`),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data?.data.status === 'running' ? 4 * 1000 : false),
    refetchIntervalInBackground: true,
    retry: (count, err) => count < 30 && (err as { status?: number }).status !== 404,
    retryDelay: 2000,
    staleTime: 2 * 1000,
  });
}

/** Run history, newest first (ADR-064 §6). */
export function useUpgradeRuns(limit = 10, enabled = true) {
  return useQuery({
    queryKey: ['upgrade-runs', limit],
    queryFn: () => apiFetch<{ readonly data: readonly UpgradeRun[] }>(`/api/v1/admin/platform/upgrade/runs?limit=${limit}`),
    enabled,
    staleTime: 15 * 1000,
    refetchInterval: (query) => (query.state.data?.data.some((r) => r.status === 'running') ? 10 * 1000 : false),
  });
}

/** Cancel a run that is still preparing nodes (the services have not changed). */
export function useCancelUpgradeRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<UpgradeRunResponse>('/api/v1/admin/platform/upgrade/run/cancel', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['upgrade-run'] });
      queryClient.invalidateQueries({ queryKey: ['upgrade-runs'] });
      queryClient.invalidateQueries({ queryKey: ['upgrade-preflight'] });
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
