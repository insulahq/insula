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
  EmailChromePreviewSampleResponse,
  NotificationProviderResponse,
  TestNotificationProviderInput,
  TestNotificationProviderResponse,
  UpdateNotificationProviderInput,
} from '@insula/api-contracts';

interface Envelope<T> { readonly data: T }

export const NOTIFICATION_PROVIDERS_KEY = ['notification-providers'] as const;

/**
 * Create/update carry operator-authored HTML (the email header/footer). As
 * application/json the edge WAF parses it into ARGS and its XSS rules refuse an
 * ordinary `<a href>` footer with a 403 the API never sees. The same JSON
 * labelled application/octet-stream is never parsed into ARGS; the API reads
 * either. ADR-060, WAF rule 9000116.
 */
const RAW_JSON_HEADERS = { 'Content-Type': 'application/octet-stream' } as const;

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
        { method: 'POST', headers: RAW_JSON_HEADERS, body: JSON.stringify(input) },
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
        { method: 'PATCH', headers: RAW_JSON_HEADERS, body: JSON.stringify(input) },
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

/**
 * A real notification, rendered server-side with sample values, that the
 * provider editor wraps in the header/footer being typed. Provider-independent,
 * so one fetch serves every editor opening; `enabled` keeps ntfy editors from
 * asking for it.
 */
export function useEmailChromePreviewSample(enabled: boolean) {
  return useQuery({
    queryKey: ['notification-email-chrome-preview-sample'] as const,
    queryFn: () => apiFetch<Envelope<EmailChromePreviewSampleResponse>>(
      '/api/v1/admin/notifications/email-chrome/preview-sample',
    ),
    enabled,
    staleTime: 5 * 60_000,
  });
}
