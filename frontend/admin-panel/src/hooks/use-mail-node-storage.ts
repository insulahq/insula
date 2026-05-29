import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { MailNodeStorageResponse } from '@insula/api-contracts';

interface Envelope {
  readonly data: MailNodeStorageResponse;
}

export const MAIL_NODE_STORAGE_KEY = ['mail', 'node-storage'] as const;

/**
 * Per-mail-node storage cards. Refreshes every 30 s — the underlying
 * data (kubelet capacity, PV listing, standby reports) changes on
 * the order of minutes at most, so a faster poll just keeps the
 * "X min ago" age counters honest without backend cost.
 */
export function useMailNodeStorage() {
  return useQuery({
    queryKey: MAIL_NODE_STORAGE_KEY,
    queryFn: () =>
      apiFetch<Envelope>('/api/v1/admin/mail/storage/per-node'),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
}
