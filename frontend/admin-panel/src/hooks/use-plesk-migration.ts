import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  PleskSourceResponse,
  PleskDiscoveryResponse,
  CreatePleskSourceInput,
} from '@insula/api-contracts';

export function usePleskSources() {
  return useQuery({
    queryKey: ['plesk-sources'],
    queryFn: () => apiFetch<{ data: PleskSourceResponse[] }>('/api/v1/admin/plesk/sources'),
  });
}

export function useCreatePleskSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePleskSourceInput) =>
      apiFetch<{ data: PleskSourceResponse }>('/api/v1/admin/plesk/sources', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plesk-sources'] }),
  });
}

export function useDeletePleskSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/v1/admin/plesk/sources/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plesk-sources'] }),
  });
}

export function useStartDiscovery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) =>
      apiFetch<{ data: { discoveryId: string } }>(`/api/v1/admin/plesk/sources/${sourceId}/discover`, {
        method: 'POST',
      }),
    onSuccess: (_d, sourceId) => {
      qc.invalidateQueries({ queryKey: ['plesk-sources'] });
      qc.invalidateQueries({ queryKey: ['plesk-discoveries', sourceId] });
    },
  });
}

/**
 * Latest discovery for a source, polled while pending/running so the
 * inventory appears as soon as the Job completes.
 */
export function useLatestDiscovery(sourceId: string | null) {
  return useQuery({
    queryKey: ['plesk-discoveries', sourceId],
    queryFn: () =>
      apiFetch<{ data: PleskDiscoveryResponse[] }>(`/api/v1/admin/plesk/sources/${sourceId}/discoveries`),
    enabled: !!sourceId,
    refetchInterval: (query) => {
      const latest = query.state.data?.data?.[0];
      return latest && (latest.status === 'pending' || latest.status === 'running') ? 3000 : false;
    },
  });
}
