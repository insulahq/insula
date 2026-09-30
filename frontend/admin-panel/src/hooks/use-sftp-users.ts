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
  const qs = new URLSearchParams();
  if (limit) qs.set('limit', String(limit));
  if (cursor) qs.set('cursor', cursor);
  if (search) qs.set('search', search);

  const base = tenantId ? `/api/v1/tenants/${tenantId}/sftp-users` : '/api/v1/admin/sftp-users';
  const q = qs.toString();

  return useQuery({
    queryKey: ['sftp-users', tenantId ?? 'all', { limit, cursor, search }],
    queryFn: () => apiFetch<PaginatedResponse<AdminSftpUser>>(`${base}${q ? `?${q}` : ''}`),
  });
}
