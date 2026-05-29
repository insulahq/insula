import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailboxBackupSettingsResponse,
  MailboxBackupSettingsUpdate,
} from '@insula/api-contracts';

interface Wrapped<T> {
  readonly data: T;
}

const KEY = ['mailbox-backup-settings'] as const;

export function useMailboxBackupSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: () =>
      apiFetch<Wrapped<MailboxBackupSettingsResponse>>('/api/v1/admin/mailbox-backup-settings'),
    staleTime: 30_000,
  });
}

export function useUpdateMailboxBackupSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MailboxBackupSettingsUpdate) =>
      apiFetch<Wrapped<MailboxBackupSettingsResponse>>('/api/v1/admin/mailbox-backup-settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
}
