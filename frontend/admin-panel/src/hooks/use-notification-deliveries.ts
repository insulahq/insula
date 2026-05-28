/**
 * TanStack Query hook for the platform-admin notification-delivery
 * audit log. Cursor-paginated; backend caps `limit` at 100.
 *
 * The filters object is stable input — each unique filter combination
 * gets its own cache row so back/forward through cursor pages doesn't
 * blow away previous results.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  NotificationDeliveryResponse,
  NotificationDeliveryStatus,
  NotificationChannelId,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> {
  readonly data: T;
  readonly pagination?: {
    readonly nextCursor?: string | null;
    readonly limit: number;
  };
}

export const NOTIFICATION_DELIVERIES_QUERY_KEY = ['notification-deliveries'] as const;

export interface NotificationDeliveryFilters {
  readonly channel?: NotificationChannelId;
  readonly status?: NotificationDeliveryStatus;
  readonly categoryId?: string;
  readonly tenantId?: string;
  readonly sinceSeconds?: number;
}

interface DeliveriesQueryInput {
  readonly filters: NotificationDeliveryFilters;
  readonly cursor?: string;
  readonly limit?: number;
}

function buildQs(input: DeliveriesQueryInput): string {
  const p = new URLSearchParams();
  if (input.filters.channel) p.set('channel', input.filters.channel);
  if (input.filters.status) p.set('status', input.filters.status);
  if (input.filters.categoryId) p.set('categoryId', input.filters.categoryId);
  if (input.filters.tenantId) p.set('tenantId', input.filters.tenantId);
  if (input.filters.sinceSeconds !== undefined) p.set('sinceSeconds', String(input.filters.sinceSeconds));
  if (input.cursor) p.set('cursor', input.cursor);
  if (input.limit !== undefined) p.set('limit', String(input.limit));
  const q = p.toString();
  return q ? `?${q}` : '';
}

/** GET /api/v1/admin/notifications/deliveries — filtered + cursor paginated. */
export function useNotificationDeliveries(input: DeliveriesQueryInput) {
  return useQuery({
    queryKey: [
      ...NOTIFICATION_DELIVERIES_QUERY_KEY,
      input.filters.channel ?? null,
      input.filters.status ?? null,
      input.filters.categoryId ?? null,
      input.filters.tenantId ?? null,
      input.filters.sinceSeconds ?? null,
      input.cursor ?? null,
      input.limit ?? null,
    ],
    queryFn: () => apiFetch<Envelope<NotificationDeliveryResponse[]>>(
      `/api/v1/admin/notifications/deliveries${buildQs(input)}`,
    ),
  });
}

/** POST /api/v1/admin/notifications/deliveries/:id/retry — operator-driven
 *  requeue. Backend resets attempt + status='queued' and re-enqueues the
 *  pg-boss job. Refuses with 409 if the delivery isn't in `failed` / `dlq`. */
export function useRetryNotificationDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      apiFetch<Envelope<{ id: string; status: string }>>(
        `/api/v1/admin/notifications/deliveries/${deliveryId}/retry`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATION_DELIVERIES_QUERY_KEY });
    },
  });
}
