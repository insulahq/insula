import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailBackupListResponse,
  MailBackupRestoreResponse,
} from '@insula/api-contracts';

interface ListEnvelope { readonly data: MailBackupListResponse }
interface RestoreEnvelope { readonly data: MailBackupRestoreResponse }

export function useMailBackups() {
  return useQuery({
    queryKey: ['mail', 'backups'],
    queryFn: () => apiFetch<ListEnvelope>('/api/v1/admin/mail/backups'),
    // Listing is expensive (spawns a Pod) — don't auto-refetch.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useRestoreMailBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ shortId, targetNode, confirmShortId }: {
      shortId: string;
      targetNode: string;
      confirmShortId: string;
    }) =>
      apiFetch<RestoreEnvelope>(`/api/v1/admin/mail/backups/${shortId}/restore`, {
        method: 'POST',
        body: JSON.stringify({ targetNode, confirmShortId }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mail', 'backups'] });
      void qc.invalidateQueries({ queryKey: ['mail', 'placement'] });
      void qc.invalidateQueries({ queryKey: ['mail', 'migration'] });
    },
  });
}
