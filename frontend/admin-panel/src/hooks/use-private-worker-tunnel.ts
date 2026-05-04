import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  TunnelSettingsResponse,
  TunnelStatusResponse,
  UpdateTunnelSettingsInput,
} from '@k8s-hosting/api-contracts';

interface ApiEnvelope<T> {
  readonly data: T;
}

const SETTINGS_KEY = ['private-worker-tunnel-settings'] as const;
const STATUS_KEY = ['private-worker-tunnel-status'] as const;
const STATUS_REFETCH_MS = 15_000;

/**
 * Fetch the per-worker-tunnel cert-manager ClusterIssuer name. The
 * settings endpoint just returns the configured issuer string — see
 * `usePrivateWorkerTunnelStatus` for the full readiness/cert-counter
 * surface that backs the operator dashboard.
 */
export function usePrivateWorkerTunnelSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () =>
      apiFetch<ApiEnvelope<TunnelSettingsResponse>>(
        '/api/v1/admin/private-workers/tunnel-settings',
      ),
    staleTime: 30_000,
  });
}

/**
 * Polls /admin/private-workers/tunnel-status every 15s. Drives the
 * status panel: anchor cert readiness, per-worker cert counters,
 * available ClusterIssuers, and the active worker count.
 */
export function usePrivateWorkerTunnelStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () =>
      apiFetch<ApiEnvelope<TunnelStatusResponse>>(
        '/api/v1/admin/private-workers/tunnel-status',
      ),
    refetchInterval: STATUS_REFETCH_MS,
    refetchOnWindowFocus: false,
  });
}

/**
 * PATCH /admin/private-workers/tunnel-settings — switch the
 * ClusterIssuer used for new per-worker cert orders. Existing certs
 * keep their previous issuer until renewal. Invalidates both the
 * settings and the status queries so the UI reflects the new current
 * issuer + readiness state immediately.
 */
export function useUpdatePrivateWorkerTunnelIssuer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateTunnelSettingsInput) =>
      apiFetch<ApiEnvelope<TunnelSettingsResponse>>(
        '/api/v1/admin/private-workers/tunnel-settings',
        {
          method: 'PATCH',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
  });
}
