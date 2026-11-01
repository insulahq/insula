import { useQuery } from '@tanstack/react-query';
import type { TenantUserResponse } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';
import { resortPlaceholder } from '@/hooks/resort-placeholder';

/** A row of GET /admin/tenant-users — the contract type. */
export type TenantUser = TenantUserResponse;

interface UseTenantUsersParams {
  readonly limit?: number;
  readonly cursor?: string;
  readonly search?: string;
  /** `field:asc|desc` — the server orders (and pages) the whole list by it. */
  readonly sort?: string;
}

export function useTenantUsers(params: UseTenantUsersParams = {}) {
  const { limit, cursor, search, sort } = params;
  const qs = new URLSearchParams();
  if (limit) qs.set('limit', String(limit));
  if (cursor) qs.set('cursor', cursor);
  if (search) qs.set('search', search);
  if (sort) qs.set('sort', sort);
  const url = `/api/v1/admin/tenant-users${qs.toString() ? `?${qs.toString()}` : ''}`;

  return useQuery({
    queryKey: ['tenant-users', { limit, cursor, search, sort }],
    queryFn: () => apiFetch<PaginatedResponse<TenantUser>>(url),
    ...resortPlaceholder<PaginatedResponse<TenantUser>>({ limit, search }, sort, cursor),
  });
}
