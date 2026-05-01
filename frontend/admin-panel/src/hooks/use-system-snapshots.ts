import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  SystemSnapshotsResponse,
  SystemRecurringJobsResponse,
  SystemSnapshotsListResponse,
  SystemSnapshotPruneResponse,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> { readonly data: T }

/**
 * Inventory of platform/system PVCs with snapshot counters. Drives the
 * "System Snapshots" section on the Backups & Snapshots → Snapshots tab.
 */
export function useSystemSnapshots() {
  return useQuery({
    queryKey: ['system-snapshots'],
    queryFn: () => apiFetch<Envelope<SystemSnapshotsResponse>>('/api/v1/admin/system-snapshots'),
    staleTime: 30_000,
  });
}

export function useRecurringJobs(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['system-snapshots', 'recurring-jobs'],
    queryFn: () => apiFetch<Envelope<SystemRecurringJobsResponse>>('/api/v1/admin/system-snapshots/recurring-jobs'),
    enabled: opts.enabled ?? true,
    staleTime: 60_000,
  });
}

export function useUpdateRecurringJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { jobName: string; cron?: string; retain?: number }) => {
      const body: Record<string, unknown> = {};
      if (input.cron !== undefined) body.cron = input.cron;
      if (input.retain !== undefined) body.retain = input.retain;
      return apiFetch<Envelope<{ ok: true }>>(
        `/api/v1/admin/system-snapshots/recurring-jobs/${encodeURIComponent(input.jobName)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['system-snapshots'] });
    },
  });
}

export function useVolumeSnapshots(volumeName: string | null) {
  return useQuery({
    queryKey: ['system-snapshots', volumeName],
    queryFn: () => apiFetch<Envelope<SystemSnapshotsListResponse>>(
      `/api/v1/admin/system-snapshots/${encodeURIComponent(volumeName!)}/snapshots`,
    ),
    enabled: Boolean(volumeName),
    staleTime: 10_000,
  });
}

export function useTakeSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { volumeName: string; label?: string }) =>
      apiFetch<Envelope<{ snapshotName: string }>>(
        `/api/v1/admin/system-snapshots/${encodeURIComponent(input.volumeName)}/snapshots`,
        { method: 'POST', body: JSON.stringify({ label: input.label }) },
      ),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['system-snapshots', vars.volumeName] });
      qc.invalidateQueries({ queryKey: ['system-snapshots'] });
    },
  });
}

export function useDeleteSystemSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { volumeName: string; snapshotName: string }) =>
      apiFetch<Envelope<{ ok: true }>>(
        `/api/v1/admin/system-snapshots/${encodeURIComponent(input.volumeName)}/snapshots/${encodeURIComponent(input.snapshotName)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['system-snapshots', vars.volumeName] });
      qc.invalidateQueries({ queryKey: ['system-snapshots'] });
    },
  });
}

export function usePruneSystemSnapshots() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { volumeName: string; keepNewest?: number }) => {
      const qs = input.keepNewest !== undefined ? `?keepNewest=${input.keepNewest}` : '';
      return apiFetch<Envelope<SystemSnapshotPruneResponse>>(
        `/api/v1/admin/system-snapshots/${encodeURIComponent(input.volumeName)}/snapshots${qs}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['system-snapshots', vars.volumeName] });
      qc.invalidateQueries({ queryKey: ['system-snapshots'] });
    },
  });
}

export function useRestoreSystemSnapshot() {
  return useMutation({
    mutationFn: (input: { volumeName: string; snapshotName: string }) =>
      apiFetch<Envelope<{ ok: true }>>(
        `/api/v1/admin/system-snapshots/${encodeURIComponent(input.volumeName)}/snapshots/${encodeURIComponent(input.snapshotName)}/restore`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
  });
}
