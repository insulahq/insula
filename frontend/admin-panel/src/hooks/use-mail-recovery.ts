import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailRecoveryStatusResponse,
  MailRecoverResponse,
} from '@insula/api-contracts';

interface StatusEnvelope { readonly data: MailRecoveryStatusResponse }
interface RecoverEnvelope { readonly data: MailRecoverResponse }

const KEY = ['mail', 'recovery-status'] as const;

export function useMailRecoveryStatus() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<StatusEnvelope>('/api/v1/admin/mail/recovery-status'),
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useStartMailRecover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ targetNode, confirmTargetNode }: {
      targetNode: string;
      confirmTargetNode: string;
    }) =>
      apiFetch<RecoverEnvelope>('/api/v1/admin/mail/recover', {
        method: 'POST',
        body: JSON.stringify({ targetNode, confirmTargetNode }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ['mail', 'placement'] });
      void qc.invalidateQueries({ queryKey: ['mail', 'health'] });
    },
  });
}
