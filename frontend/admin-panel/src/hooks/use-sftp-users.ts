import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { PaginatedResponse } from '@/types/api';

/** One SFTP account with the tenant that owns it. */
export interface AdminSftpUser {
  readonly id: string;
  readonly tenantId: string;
  readonly username: string;
  readonly homePath: string;
  readonly description: string | null;
  readonly enabled: number;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly tenantName: string | null;
}

interface UseSftpUsersParams {
  readonly tenantId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly search?: string;
  /**
   * `field:asc|desc` — the server orders (and pages) the whole list by it.
   * Only the cross-tenant listing sorts; a one-tenant listing ignores it.
   */
  readonly sort?: string;
}

/**
 * Every SFTP account, or one tenant's.
 *
 * The cross-tenant listing is operator-only at the API — the blanket tenant
 * hooks on that route file do not restrict an `/admin/*` path, so it names
 * `requireRole` itself. Worth knowing here: a tenant-panel caller gets 403,
 * not an empty list.
 */
export function useSftpUsers(params: UseSftpUsersParams = {}) {
  const { tenantId, limit, cursor, search } = params;
  // The per-tenant endpoint has no server sort, so it is never sent there.
  const sort = tenantId ? undefined : params.sort;
  const qs = new URLSearchParams();
  if (limit) qs.set('limit', String(limit));
  if (cursor) qs.set('cursor', cursor);
  if (search) qs.set('search', search);
  if (sort) qs.set('sort', sort);

  const base = tenantId ? `/api/v1/tenants/${tenantId}/sftp-users` : '/api/v1/admin/sftp-users';
  const q = qs.toString();

  return useQuery({
    queryKey: ['sftp-users', tenantId ?? 'all', { limit, cursor, search, sort }],
    queryFn: () => apiFetch<PaginatedResponse<AdminSftpUser>>(`${base}${q ? `?${q}` : ''}`),
  });
}
