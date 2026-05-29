import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  UserNotificationPreferencesResponse,
  UpdateUserNotificationPreferencesInput,
  UserNotificationSettingsResponse,
  UpdateUserNotificationSettingsInput,
} from '@insula/api-contracts';

export interface NotificationEntry {
  readonly id: string;
  readonly userId: string;
  readonly type: 'info' | 'warning' | 'error' | 'success';
  readonly title: string;
  readonly message: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  /**
   * Backend stores this as a tinyint (0 or 1). Compare explicitly with
   * `=== 0` / `!== 0` to avoid silent breakage if the API ever returns
   * other integers.
   */
  readonly isRead: 0 | 1;
  readonly readAt: string | null;
  readonly createdAt: string;
}

interface NotificationsResponse {
  readonly data: readonly NotificationEntry[];
}

interface UnreadCountResponse {
  readonly data: { readonly count: number };
}

export function useNotifications(limit = 20, unreadOnly = false) {
  return useQuery({
    queryKey: ['notifications', limit, unreadOnly],
    queryFn: () => apiFetch<NotificationsResponse>(
      `/api/v1/notifications?limit=${limit}${unreadOnly ? '&unread_only=true' : ''}`,
    ),
    refetchInterval: 30_000,
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: ['notifications-unread-count'],
    queryFn: () => apiFetch<UnreadCountResponse>('/api/v1/notifications/unread-count'),
    refetchInterval: 30_000,
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<void>('/api/v1/notifications/mark-read', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-unread-count'] });
    },
  });
}

/** Mark EVERY unread notification for the current user as read in one
 *  request. Use this for the bell-badge "Mark all read" affordance —
 *  the per-id variant above only covers visible/passed ids, which
 *  silently leaves the bell badge non-zero when the user has more
 *  unread than the dropdown lists. */
export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: { updated: number } }>('/api/v1/notifications/mark-all-read', {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-unread-count'] });
    },
  });
}

export function useDeleteNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/notifications/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-unread-count'] });
    },
  });
}

// ─── Per-user notification preferences (Phase 1) ───
// Backend: GET/PATCH /api/v1/notifications/preferences|settings.

export const NOTIFICATION_PREFERENCES_KEY = ['notifications', 'preferences'] as const;
export const NOTIFICATION_SETTINGS_KEY = ['notifications', 'settings'] as const;

export function useNotificationPreferences() {
  return useQuery({
    queryKey: NOTIFICATION_PREFERENCES_KEY,
    queryFn: () => apiFetch<{ data: UserNotificationPreferencesResponse }>(
      '/api/v1/notifications/preferences',
    ),
  });
}

export function useUpdateNotificationPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateUserNotificationPreferencesInput) =>
      apiFetch<{ data: UserNotificationPreferencesResponse }>(
        '/api/v1/notifications/preferences',
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATION_PREFERENCES_KEY });
    },
  });
}

export function useNotificationSettings() {
  return useQuery({
    queryKey: NOTIFICATION_SETTINGS_KEY,
    queryFn: () => apiFetch<{ data: UserNotificationSettingsResponse }>(
      '/api/v1/notifications/settings',
    ),
  });
}

export function useUpdateNotificationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateUserNotificationSettingsInput) =>
      apiFetch<{ data: UserNotificationSettingsResponse }>(
        '/api/v1/notifications/settings',
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATION_SETTINGS_KEY });
    },
  });
}
