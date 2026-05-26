import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';

export interface TenantUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleName: string;
  readonly status: string;
  readonly tenantId: string | null;
  readonly tenantName: string | null;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}

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
