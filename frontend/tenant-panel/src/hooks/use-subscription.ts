/**
 * Round-4 Phase C: tenant-panel subscription viewing hook.
 *
 * Backend endpoint: `GET /api/v1/tenants/:id/subscription` — now
 * accessible to tenant_admin + tenant_user (scoped to the
 * authenticated tenant's own id via requireTenantAccess).
 *
 * PATCH remains admin/billing-only, so there is no mutation hook
 * here.
 */

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface SubscriptionPlan {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly cpuLimit: string;
  readonly memoryLimit: string;
  readonly storageLimit: string;
  readonly monthlyPriceUsd: string;
  readonly maxSubUsers: number;
  readonly maxMailboxes: number;
  readonly status: string;
}

export interface Subscription {
  readonly tenant_id: string;
  readonly plan: SubscriptionPlan | null;
  readonly status: string;
  readonly subscription_expires_at: string | null;
  readonly created_at: string;
}

export function useSubscription(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['subscription', tenantId],
    queryFn: () =>
      apiFetch<{ data: Subscription }>(`/api/v1/tenants/${tenantId}/subscription`),
    enabled: Boolean(tenantId),
    staleTime: 60_000,
  });
}
