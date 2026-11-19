import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { MailServerMemoryResponse } from '@insula/api-contracts';

interface Envelope {
  readonly data: MailServerMemoryResponse;
}

export const MAIL_SERVER_MEMORY_KEY = ['mail', 'server', 'memory'] as const;

/**
 * Stalwart's process memory, its limit and the last 7 days (hourly peaks).
 * The metrics store scrapes once a minute, so polling faster shows nothing new.
 */
export function useMailServerMemory() {
  return useQuery({
    queryKey: MAIL_SERVER_MEMORY_KEY,
    queryFn: () => apiFetch<Envelope>('/api/v1/admin/mail/server/memory'),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}
