/**
 * Tenant-panel hooks for self-service Tenant Backup. Reads from
 * /api/v1/tenant/backups/* — the JWT carries the tenantId so the
 * hooks don't need it as a parameter.
 *
 * 2026-05-28: schedule hooks removed; on-demand `useRunBundleNow`
 * added. Per platform policy, tenants don't set their own schedules.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import type { BundleSummary, RestoreJobSummary } from '@insula/api-contracts';

interface BundlesResponse { readonly data: readonly BundleSummary[] }
interface RunNowResponse {
  readonly data: {
    readonly bundleId: string;
    readonly status: string;
    readonly message: string;
  };
}

export function useTenantBundles() {
  return useQuery({
    queryKey: ['tenant-backups', 'bundles'],
    queryFn: () => apiFetch<BundlesResponse>('/api/v1/tenant/backups/bundles'),
  });
}

/**
 * List recent restore carts for the authenticated tenant. Used by
 * the Backups page to surface in-flight + recently-completed
 * restores so the tenant can resume a paused cart or audit history.
 */
export function useTenantRestoreCarts() {
  const tenantId = useAuth((s) => s.user?.tenantId);
  return useQuery({
    queryKey: ['tenant-restore-carts', tenantId],
    queryFn: () => {
      if (!tenantId) throw new Error('No tenant id on session');
      return apiFetch<{ data: readonly RestoreJobSummary[] }>(
        `/api/v1/tenants/${tenantId}/restore-carts`,
      );
    },
    enabled: Boolean(tenantId),
  });
}

/**
 * Discard a restore cart the tenant no longer wants.
 *
 * Draft carts already expire after 7 days server-side, but that is a sweeper,
 * not a UX — a tenant who opened a restore by mistake should not have to look
 * at it for a week. The server refuses `executing` carts with 409; the caller
 * surfaces that rather than pretending it worked.
 */
export function useDeleteRestoreCart() {
  const tenantId = useAuth((s) => s.user?.tenantId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cartId: string) => {
      if (!tenantId) throw new Error('No tenant id on session');
      return apiFetch<void>(
        `/api/v1/tenants/${tenantId}/restore-carts/${cartId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-restore-carts', tenantId] });
    },
  });
}

export function useRunBundleNow() {
  const qc = useQueryClient();
  const tenantId = useAuth((s) => s.user?.tenantId);
  return useMutation({
    mutationFn: () => {
      if (!tenantId) throw new Error('No tenant id on session');
      return apiFetch<RunNowResponse>(`/api/v1/tenants/${tenantId}/bundles/run-now`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-backups', 'bundles'] }),
  });
}

/**
 * Trigger a browser download of the encrypted GDPR data-export
 * tarball for one bundle. Pattern mirrors the admin-panel hook —
 * fetch + Blob + URL.createObjectURL because <a href> can't carry
 * the Bearer header.
 */
export async function downloadTenantDataExport(bundleId: string): Promise<void> {
  const token = localStorage.getItem('auth_token');
  const r = await fetch(`/api/v1/tenant/backups/bundles/${bundleId}/data-export`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch { /* ignore */ }
    throw new Error(`download failed (${r.status}): ${detail.slice(0, 200)}`);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `data-export-${bundleId}.tar.gz.enc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
