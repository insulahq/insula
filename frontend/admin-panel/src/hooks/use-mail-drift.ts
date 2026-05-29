import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailDriftListResponse,
  MailDriftDismissResponse,
  MailDriftRecreateResponse,
} from '@insula/api-contracts';

interface ListEnvelope { readonly data: MailDriftListResponse }
interface DismissEnvelope { readonly data: MailDriftDismissResponse }
interface RecreateEnvelope { readonly data: MailDriftRecreateResponse }

const QUERY_KEY = ['mail', 'drift'] as const;

export function useMailDrift() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch<ListEnvelope>('/api/v1/admin/mail/drift'),
    // Drift list rarely changes between user actions; 30s stale time
    // keeps the badge fresh without hammering the API.
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useDismissMailDrift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<DismissEnvelope>(`/api/v1/admin/mail/drift/${id}/dismiss`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

export function useRecreateMailDriftEmpty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmName }: { id: string; confirmName: string }) =>
      apiFetch<RecreateEnvelope>(`/api/v1/admin/mail/drift/${id}/recreate-empty`, {
        method: 'POST',
        body: JSON.stringify({ confirmName }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      // Mail health may reflect the new entry; also invalidate.
      void qc.invalidateQueries({ queryKey: ['mail', 'health'] });
    },
  });
}
