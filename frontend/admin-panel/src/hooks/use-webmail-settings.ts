import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { WebmailSettingsResponse, UpdateWebmailSettingsRequest} from '@insula/api-contracts';

interface WebmailSettingsWrapped {
  readonly data: WebmailSettingsResponse;
}

// 2026-05-18: engine flips now run through the task-center. When the
// PATCH payload contains `defaultWebmailEngine`, the backend kicks off
// a 5-step background task and returns `taskId` alongside the updated
// settings. The frontend opens MailTaskProgressModal so the operator
// sees IR-flip → Pod-scale → wait-ready → URL-verify in real time.
interface UpdateWebmailSettingsWrapped {
  readonly data: WebmailSettingsResponse & { readonly taskId?: string };
}

export function useWebmailSettings() {
  return useQuery({
    queryKey: ['webmail-settings'],
    queryFn: () => apiFetch<WebmailSettingsWrapped>('/api/v1/admin/webmail-settings'),
    staleTime: 60_000,
  });
}

// UpdateWebmailSettingsRequest comes from @insula/api-contracts (updateWebmailSettingsSchema) — the shape the backend parses with.

export function useUpdateWebmailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWebmailSettingsRequest) =>
      apiFetch<UpdateWebmailSettingsWrapped>('/api/v1/admin/webmail-settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webmail-settings'] });
      // Bump the task-center chip immediately when the engine-flip task is
      // emitted — otherwise the operator waits up to 30s for the next poll.
      queryClient.invalidateQueries({ queryKey: ['task-center', 'me'] });
    },
  });
}
