import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';

export interface AdminMailbox {
  readonly id: string;
  readonly emailDomainId: string;
  readonly tenantId: string;
  readonly localPart: string;
  readonly fullAddress: string;
  readonly displayName: string | null;
  readonly quotaMb: number;
  readonly usedMb: number;
  readonly status: string;
  readonly mailboxType: string;
  readonly autoReply: number;
  readonly autoReplySubject: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tenantName: string | null;
  readonly emailDomain: string | null;
}

interface UseAdminMailboxesParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly search?: string;
}

export function useAdminMailboxes(params: UseAdminMailboxesParams = {}) {
  const { limit, cursor, search } = params;
  const qs = new URLSearchParams();
  if (limit) qs.set('limit', String(limit));
  if (cursor) qs.set('cursor', cursor);
  if (search) qs.set('search', search);
  const url = `/api/v1/admin/mailboxes${qs.toString() ? `?${qs.toString()}` : ''}`;

  return useQuery({
    queryKey: ['admin-mailboxes', { limit, cursor, search }],
    queryFn: () => apiFetch<PaginatedResponse<AdminMailbox>>(url),
  });
}
