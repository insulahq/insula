/**
 * Tenant-panel React Query hooks for the restore-cart APIs.
 *
 * Mirrors the admin-panel hooks but hits the tenant-scoped routes:
 *   /api/v1/tenants/:tenantId/restore-carts/...
 *   /api/v1/tenants/:tenantId/bundles/:bundleId/browse/...
 *
 * The tenant-scoped routes enforce `assertOwnership(bundle.tenantId
 * === path.tenantId)` and `tenant-restore-policy` server-side, so a
 * forged bundleId or table selector can't escape the tenant boundary
 * even from a tampered request.
 *
 * Shape matches `RestoreCartHooks` in @k8s-hosting/ui-restore-cart
 * so the shared `RestoreCartLayout` renders identically for tenants.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import type {
  AddRestoreItemInput,
  RestoreCartDetail,
  RestoreItemInfo,
  RestoreCartStatus,
  BrowseConfigTablesData,
  BrowseDeploymentsData,
  BrowseDomainsData,
  BrowseMailboxesData,
  BrowseFilesData,
} from '@k8s-hosting/ui-restore-cart';

interface CartDetailEnvelope { readonly data: RestoreCartDetail }
interface CartSummaryEnvelope { readonly data: { id: string; tenantId: string; status: RestoreCartStatus } }
interface CartItemEnvelope { readonly data: RestoreItemInfo }

const useTenantId = () => useAuth((s) => s.user?.tenantId) ?? '';
const tenantBase = (tenantId: string) => `/api/v1/tenants/${tenantId}`;

// ── Cart CRUD ─────────────────────────────────────────────────────

export function useRestoreCart(cartId: string | null) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: ['tenant-restore-cart', cartId],
    enabled: !!(tenantId && cartId),
    queryFn: () => apiFetch<CartDetailEnvelope>(`${tenantBase(tenantId)}/restore-carts/${cartId}`),
    refetchInterval: (q) => {
      const status = q?.state?.data?.data?.status;
      return status === 'executing' ? 2000 : false;
    },
  });
}

export function useCreateRestoreCart() {
  const tenantId = useTenantId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { tenantId: string; description?: string }) =>
      apiFetch<CartSummaryEnvelope>(`${tenantBase(input.tenantId)}/restore-carts`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId: input.tenantId,
          description: input.description ?? null,
        }),
      }),
    onSuccess: (resp) => qc.invalidateQueries({ queryKey: ['tenant-restore-cart', resp.data.id] }),
  });
}

export function useAddRestoreItem(cartId: string) {
  const tenantId = useTenantId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddRestoreItemInput & { bundleId: string; label?: string }) =>
      apiFetch<CartItemEnvelope>(`${tenantBase(tenantId)}/restore-carts/${cartId}/items`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-restore-cart', cartId] }),
  });
}

export function useRemoveRestoreItem(cartId: string) {
  const tenantId = useTenantId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      apiFetch<{ data: null }>(`${tenantBase(tenantId)}/restore-carts/${cartId}/items/${itemId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-restore-cart', cartId] }),
  });
}

export function useExecuteRestoreCart(cartId: string) {
  const tenantId = useTenantId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<CartDetailEnvelope>(`${tenantBase(tenantId)}/restore-carts/${cartId}/execute`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-restore-cart', cartId] }),
  });
}

// ── Bundle browse ───────────────────────────────────────────────────

interface BrowseEnvelope<T> { readonly data: T }

const browseUrl = (tenantId: string, bundleId: string, sub: string) =>
  `${tenantBase(tenantId)}/bundles/${bundleId}/browse/${sub}`;

export function useBrowseConfigTables(bundleId: string | null) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: ['tenant-bundle-browse', 'config-tables', bundleId],
    enabled: !!(tenantId && bundleId),
    queryFn: () => apiFetch<BrowseEnvelope<BrowseConfigTablesData>>(browseUrl(tenantId, bundleId!, 'config-tables')),
  });
}

export function useBrowseDeployments(bundleId: string | null) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: ['tenant-bundle-browse', 'deployments', bundleId],
    enabled: !!(tenantId && bundleId),
    queryFn: () => apiFetch<BrowseEnvelope<BrowseDeploymentsData>>(browseUrl(tenantId, bundleId!, 'deployments')),
  });
}

export function useBrowseDomains(bundleId: string | null) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: ['tenant-bundle-browse', 'domains', bundleId],
    enabled: !!(tenantId && bundleId),
    queryFn: () => apiFetch<BrowseEnvelope<BrowseDomainsData>>(browseUrl(tenantId, bundleId!, 'domains')),
  });
}

export function useBrowseMailboxes(bundleId: string | null) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: ['tenant-bundle-browse', 'mailboxes', bundleId],
    enabled: !!(tenantId && bundleId),
    queryFn: () => apiFetch<BrowseEnvelope<BrowseMailboxesData>>(browseUrl(tenantId, bundleId!, 'mailboxes')),
  });
}

export function useBrowseFiles(bundleId: string | null, after: string | null, limit = 500) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: ['tenant-bundle-browse', 'files', bundleId, after, limit],
    enabled: !!(tenantId && bundleId),
    queryFn: () => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (after) qs.set('after', after);
      return apiFetch<BrowseEnvelope<BrowseFilesData>>(
        `${browseUrl(tenantId, bundleId!, 'files/tree')}?${qs.toString()}`,
      );
    },
  });
}
