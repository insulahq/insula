import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { LifecycleHookErrorEnvelope } from '@k8s-hosting/api-contracts';

interface Envelope<T> { readonly data: T }

export interface LifecycleTransitionRow {
  id: string;
  tenantId: string;
  transitionKind: 'active' | 'suspended' | 'archived' | 'restored' | 'deleted';
  fromStatus: string | null;
  toStatus: string;
  triggeredByUserId: string | null;
  state: 'running' | 'completed' | 'failed_partial' | 'failed_blocking';
  startedAt: string;
  completedAt: string | null;
  namespace: string | null;
  detail: Record<string, unknown> | null;
}

export interface LifecycleHookRunRow {
  id: string;
  transitionId: string;
  hookName: string;
  hookOrder: number;
  blocking: 'abort' | 'continue';
  state: 'pending' | 'running' | 'ok' | 'noop' | 'failed';
  attempts: number;
  maxAttempts: number;
  lastError: LifecycleHookErrorEnvelope | null;
  startedAt: string | null;
  completedAt: string | null;
  nextAttemptAt: string | null;
}

export interface TransitionsResponse {
  transitions: LifecycleTransitionRow[];
  hookRuns: Record<string, LifecycleHookRunRow[]>;
}

export interface BulkOpResponse extends TransitionsResponse {
  bulkOpId: string;
}

/** List recent transitions (cluster-wide or filtered by tenantId). */
export function useLifecycleTransitions(opts: {
  tenantId?: string;
  limit?: number;
  refetchInterval?: number;
} = {}) {
  const params = new URLSearchParams();
  if (opts.tenantId) params.set('tenantId', opts.tenantId);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return useQuery({
    queryKey: ['lifecycle-transitions', opts.tenantId ?? 'all', opts.limit ?? 50],
    queryFn: () => apiFetch<Envelope<TransitionsResponse>>(`/api/v1/admin/lifecycle/transitions${qs ? `?${qs}` : ''}`),
    refetchInterval: opts.refetchInterval ?? undefined,
  });
}

/**
 * Per-tenant transitions (live-poll variant for the progress modal).
 *
 * Pass `paused=true` to stop polling — TanStack Query honours `false`
 * returned from a refetchInterval function and stops the timer
 * (whereas a fixed prop value is only read at construction). The
 * caller is responsible for setting `paused` once the work is done.
 */
export function useTenantLifecycleTransitions(
  tenantId: string,
  refetchIntervalMs = 2000,
  paused = false,
) {
  return useQuery({
    queryKey: ['tenant-lifecycle-transitions', tenantId],
    queryFn: () => apiFetch<Envelope<TransitionsResponse>>(`/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/lifecycle/transitions`),
    refetchInterval: paused ? false : refetchIntervalMs,
    enabled: !!tenantId,
  });
}

/** Poll all transitions for a single bulk operation by id. */
export function useBulkOpProgress(
  bulkOpId: string | null,
  refetchIntervalMs = 2000,
  paused = false,
) {
  return useQuery({
    queryKey: ['lifecycle-bulk-op', bulkOpId],
    queryFn: () => apiFetch<Envelope<BulkOpResponse>>(`/api/v1/admin/lifecycle/bulk-ops/${encodeURIComponent(bulkOpId!)}`),
    refetchInterval: paused ? false : refetchIntervalMs,
    enabled: !!bulkOpId,
  });
}

/** Force a failed hook_run to retry on the next scheduler tick. */
export function useRetryHookRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiFetch<Envelope<{ retryQueuedAt: string }>>(`/api/v1/admin/lifecycle/hook-runs/${encodeURIComponent(runId)}/retry`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lifecycle-transitions'] });
      qc.invalidateQueries({ queryKey: ['tenant-lifecycle-transitions'] });
      qc.invalidateQueries({ queryKey: ['lifecycle-bulk-op'] });
    },
  });
}

/** Clear the in-memory circuit breaker for one hook. */
export function useResetHookBreaker() {
  return useMutation({
    mutationFn: (hookName: string) =>
      apiFetch<Envelope<{ hookName: string; wasOpen: boolean }>>(`/api/v1/admin/lifecycle/breakers/${encodeURIComponent(hookName)}/reset`, {
        method: 'POST',
      }),
  });
}

/** Aggregate hook stats from a transitions response — used by the
 *  Settings page to render the per-hook success-rate panel. */
export function summariseHookStats(resp: TransitionsResponse | undefined): Array<{
  hookName: string;
  total: number;
  ok: number;
  failed: number;
  successRatePct: number;
}> {
  if (!resp) return [];
  const counts = new Map<string, { total: number; ok: number; failed: number }>();
  for (const runs of Object.values(resp.hookRuns)) {
    for (const r of runs) {
      const c = counts.get(r.hookName) ?? { total: 0, ok: 0, failed: 0 };
      c.total++;
      if (r.state === 'ok' || r.state === 'noop') c.ok++;
      if (r.state === 'failed') c.failed++;
      counts.set(r.hookName, c);
    }
  }
  return Array.from(counts, ([hookName, c]) => ({
    hookName,
    total: c.total,
    ok: c.ok,
    failed: c.failed,
    successRatePct: c.total > 0 ? Math.round((c.ok / c.total) * 100) : 0,
  })).sort((a, b) => a.hookName.localeCompare(b.hookName));
}
