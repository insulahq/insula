import { useQuery } from '@tanstack/react-query';
import type { TenantUserResponse } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';

/** A row of GET /admin/tenant-users — the contract type. */
export type TenantUser = TenantUserResponse;

interface UseTenantUsersParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly search?: string;
}

export function useTenantUsers(params: UseTenantUsersParams = {}) {
  const { limit, cursor, search } = params;
  const qs = new URLSearchParams();
  if (limit) qs.set('limit', String(limit));
  if (cursor) qs.set('cursor', cursor);
  if (search) qs.set('search', search);
  const url = `/api/v1/admin/tenant-users${qs.toString() ? `?${qs.toString()}` : ''}`;

  return useQuery({
    queryKey: ['tenant-users', { limit, cursor, search }],
    queryFn: () => apiFetch<PaginatedResponse<TenantUser>>(url),
  });
}
