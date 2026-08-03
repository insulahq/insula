import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

interface PlatformVersionResponse {
  readonly data: {
    readonly currentVersion: string;
    readonly latestVersion: string | null;
    readonly latestSource: 'releases' | 'tags' | 'none' | 'unreachable';
    readonly updateAvailable: boolean;
    readonly environment: string;
    readonly autoUpdate: boolean;
    readonly imageUpdateStrategy: 'auto' | 'manual';
    readonly pendingVersion: string | null;
    readonly lastCheckedAt: string | null;
    // Version spine (ADR-045): `available` is the cosign-VERIFIED newest release
    // the poller has confirmed — the authoritative "latest" for the UI. On
    // production `latestVersion` (the lazy, unverified GitHub check) is often
    // null, so the card must prefer `available` or it perpetually reads "no
    // releases published" despite a real verified release being available.
    readonly installed: string;
    readonly running: string;
    readonly available: string | null;
    readonly availableVerifyStatus: string | null;
  };
}

export type PlatformVersionData = PlatformVersionResponse['data'];

export function usePlatformVersion() {
  return useQuery({
    queryKey: ['platform-version'],
    queryFn: () => apiFetch<PlatformVersionResponse>('/api/v1/admin/platform/version'),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });
}

/**
 * Force a real poll of GitHub, then refresh the version card.
 *
 * `usePlatformVersion` only reads what the hourly poller CronJob last stored,
 * and its 60s staleTime means a plain refetch() often does not even hit the
 * network — so "Check for updates" could not surface a release published since
 * the last tick, no matter how many times it was clicked.
 */
export function useCheckForUpdates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<PlatformVersionResponse>('/api/v1/admin/platform/version/check', { method: 'POST' }),
    onSuccess: (res) => {
      // The POST returns the freshly-polled state; seed the cache with it so
      // the card updates immediately instead of waiting for a refetch.
      queryClient.setQueryData(['platform-version'], res);
      void queryClient.invalidateQueries({ queryKey: ['platform-version'] });
    },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (autoUpdate: boolean) =>
      apiFetch('/api/v1/admin/platform/update-settings', {
        method: 'PUT',
        body: JSON.stringify({ autoUpdate }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform-version'] }),
  });
}

// useTriggerUpdate() removed 2026-07-28. POST /admin/platform/update was the
// dead push-model no-op on the pull model. The real upgrade flow lives on the
// Upgrades page (use-platform-upgrade.ts → POST /admin/platform/upgrade).
