/**
 * React Query hooks for the one-button tenant DR recover route (gap G3).
 *
 * `POST /api/v1/admin/dr/tenants/:tenantId/recover` orchestrates the
 * existing restore-cart endpoints (provision → create cart → add items →
 * execute) to recover a tenant's data from an off-site bundle. The admin
 * panel starts it with `background: true`: the call answers with a
 * `dr.recover` task id at once and the run reports through the task center —
 * `DrRecoverProgressModal` renders it, and the chip re-opens it. Types come
 * from `@insula/api-contracts` (`dr-recover.ts`, `dr-recover-task.ts`,
 * `restore.ts`) so the UI and backend can never drift.
 *
 * `useLiveRestoreCart` polls the recovery's restore cart for per-item
 * progress until it reaches a terminal state (`done` | `failed`).
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch, ensureFreshAccessToken } from '@/lib/api-client';
import type {
  DrRecoverRequest,
  DrRecoverStarted,
  DrRecoverAllRequestInput,
  DrRecoverAllResponse,
  DrRecoverAllStarted,
  DrRecoveryInfo,
  RecoverableTenant,
  RestoreJobDetail,
  RestoreJobStatus,
} from '@insula/api-contracts';

interface DrRecoverAllEnvelope { readonly data: DrRecoverAllResponse }

/**
 * A background recovery keeps using the token it was started with (forwarded
 * into its provision / restore sub-requests) for minutes after the start
 * request returns — start it with one that will outlive that.
 */
const RECOVERY_TOKEN_MIN_VALIDITY_MS = 20 * 60_000;
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
 * Start a tenant recovery in the background. Resolves with the `dr.recover`
 * task to follow; a refusal (unknown tenant, a recovery already running)
 * rejects before any task exists.
 */
export function useStartTenantRecovery() {
  return useMutation({
    mutationFn: async ({ tenantId, input }: { tenantId: string; input: Omit<DrRecoverRequest, 'background'> }) => {
      await ensureFreshAccessToken(RECOVERY_TOKEN_MIN_VALIDITY_MS);
      return apiFetch<{ readonly data: DrRecoverStarted }>(
        `/api/v1/admin/dr/tenants/${encodeURIComponent(tenantId)}/recover`,
        {
          method: 'POST',
          body: JSON.stringify({ ...input, background: true }),
        },
      );
    },
  });
}

/**
 * Preview (dry-run) which LOST tenants a batch recover would target — resolves
 * each tenant + its newest bundle + namespace presence, WITHOUT executing any
 * recover. Lets the operator confirm the set before firing.
 */
export function useDrRecoverAllPreview() {
  return useMutation({
    mutationFn: (input: Omit<DrRecoverAllRequestInput, 'dryRun' | 'background'>) =>
      apiFetch<DrRecoverAllEnvelope>('/api/v1/admin/dr/tenants/recover-all', {
        method: 'POST',
        body: JSON.stringify({ ...input, dryRun: true }),
      }),
  });
}

/**
 * Start the batch recover-all in the background — each targeted lost tenant
 * is recovered in turn (re-create / provision / restore / reconcile). Resolves
 * with the `dr.recover-all` task to follow; the encryption-key refusal and a
 * batch already running reject before any task exists.
 */
export function useStartRecoverAll() {
  return useMutation({
    mutationFn: async (input: Omit<DrRecoverAllRequestInput, 'dryRun' | 'background'>) => {
      await ensureFreshAccessToken(RECOVERY_TOKEN_MIN_VALIDITY_MS);
      return apiFetch<{ readonly data: DrRecoverAllStarted }>('/api/v1/admin/dr/tenants/recover-all', {
        method: 'POST',
        body: JSON.stringify({ ...input, dryRun: false, background: true }),
      });
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

/**
 * Every tenant that can be restored from its bundles — DELETED ones included,
 * by name, with how long their bundles are kept. GET
 * /admin/tenant-bundles/recoverable-tenants reads backup_jobs per tenant, so a
 * deleted tenant is listed for as long as its bundles exist (the bundle list
 * is paged newest-first across all tenants and loses it within a night or two).
 */
export function useRecoverableTenants() {
  return useQuery({
    queryKey: ['recoverable-tenants'],
    queryFn: () => apiFetch<{ data: RecoverableTenant[] }>('/api/v1/admin/tenant-bundles/recoverable-tenants'),
    staleTime: 60_000,
  });
}

/**
 * What a Recover Tenant would restore: the tenant (its row, or — deleted — its
 * bundle's manifest) and every restorable bundle with when it was taken and
 * what it holds. `bundleId` picks the manifest a deleted tenant is read from.
 */
export function useRecoveryInfo(tenantId: string, bundleId: string) {
  const qs = bundleId ? `?bundleId=${encodeURIComponent(bundleId)}` : '';
  return useQuery({
    queryKey: ['dr-recovery-info', tenantId, bundleId],
    queryFn: () => apiFetch<{ data: DrRecoveryInfo }>(`/api/v1/admin/dr/tenants/${encodeURIComponent(tenantId)}/recovery-info${qs}`),
    enabled: tenantId.length > 0,
    staleTime: 30_000,
    // Choosing another bundle re-reads a deleted tenant's facts from it; keep
    // the current answer on screen meanwhile (the bundle table would otherwise
    // vanish under the click) — but never another tenant's.
    placeholderData: (prev) => (prev?.data.tenantId === tenantId ? prev : undefined),
  });
}
