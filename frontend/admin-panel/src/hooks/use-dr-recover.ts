/**
 * React Query hooks for the one-button tenant DR recover route (gap G3).
 *
 * `POST /api/v1/admin/dr/tenants/:tenantId/recover` orchestrates the
 * existing restore-cart endpoints (provision → create cart → add items →
 * execute) in a single admin call, recovering a tenant's data from an
 * off-site bundle. Types come from `@insula/api-contracts` (`dr-recover.ts`,
 * `restore.ts`) so the UI and backend can never drift.
 *
 * `useRecoverTenantFromBundle` triggers the recover; `useLiveRestoreCart`
 * polls the resulting cart's per-item progress until it reaches a terminal
 * state (`done` | `failed`).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  DrRecoverRequest,
  DrRecoverResponse,
  RestoreJobDetail,
  RestoreJobStatus,
} from '@insula/api-contracts';

interface DrRecoverEnvelope { readonly data: DrRecoverResponse }
interface CartDetailEnvelope { readonly data: RestoreJobDetail }

/** Cart statuses at which polling can stop — no further transitions expected. */
const TERMINAL_CART_STATES: ReadonlySet<RestoreJobStatus> = new Set<RestoreJobStatus>([
  'done',
  'failed',
]);

export function isTerminalCartStatus(status: RestoreJobStatus): boolean {
  return TERMINAL_CART_STATES.has(status);
}

/**
 * Trigger the one-button tenant DR recover. `tenantId` is the path
 * parameter; `input` is the (all-optional) request body.
 */
export function useRecoverTenantFromBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, input }: { tenantId: string; input: DrRecoverRequest }) =>
      apiFetch<DrRecoverEnvelope>(
        `/api/v1/admin/dr/tenants/${encodeURIComponent(tenantId)}/recover`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: (resp) => {
      // Surface the freshly-created cart to any restore-cart consumers.
      void qc.invalidateQueries({ queryKey: ['restore-cart', resp.data.cartId] });
      void qc.invalidateQueries({ queryKey: ['restore-carts'] });
    },
  });
}

/**
 * Poll a restore cart's per-item progress. Refetches every 2s while the
 * cart is non-terminal, then stops. Disabled until a `cartId` exists.
 */
export function useLiveRestoreCart(cartId: string | null) {
  return useQuery({
    queryKey: ['restore-cart', cartId],
    enabled: !!cartId,
    queryFn: () =>
      apiFetch<CartDetailEnvelope>(`/api/v1/admin/restores/carts/${cartId}`),
    refetchInterval: (query) => {
      const status = query.state.data?.data.status;
      if (status && isTerminalCartStatus(status)) return false;
      return 2_000;
    },
    retry: false,
  });
}
