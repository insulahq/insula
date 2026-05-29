/**
 * TanStack Query hooks for the Notification Provider catalogue.
 *
 * Distinct from `use-email.ts:useSmtpRelays` (which is the tenant-side
 * outbound mail relay catalog). Notification Providers are the
 * platform-internal transport endpoints used by the notification
 * dispatcher.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  CreateNotificationProviderInput,
  NotificationProviderResponse,
  TestNotificationProviderInput,
  TestNotificationProviderResponse,
  UpdateNotificationProviderInput,
} from '@insula/api-contracts';

interface Envelope<T> { readonly data: T }

export const NOTIFICATION_PROVIDERS_KEY = ['notification-providers'] as const;

export function useNotificationProviders() {
  return useQuery({
    queryKey: NOTIFICATION_PROVIDERS_KEY,
    queryFn: () => apiFetch<Envelope<NotificationProviderResponse[]>>(
      '/api/v1/admin/notifications/providers',
    ),
  });
}

export function useCreateNotificationProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNotificationProviderInput) =>
      apiFetch<Envelope<NotificationProviderResponse>>(
        '/api/v1/admin/notifications/providers',
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATION_PROVIDERS_KEY }),
  });
}

export function useUpdateNotificationProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { readonly id: string; readonly input: UpdateNotificationProviderInput }) =>
      apiFetch<Envelope<NotificationProviderResponse>>(
        `/api/v1/admin/notifications/providers/${id}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATION_PROVIDERS_KEY }),
  });
}

export function useDeleteNotificationProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/admin/notifications/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATION_PROVIDERS_KEY }),
  });
}

export function useTestNotificationProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { readonly id: string; readonly input: TestNotificationProviderInput }) =>
      apiFetch<Envelope<TestNotificationProviderResponse>>(
        `/api/v1/admin/notifications/providers/${id}/test`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATION_PROVIDERS_KEY }),
  });
}
