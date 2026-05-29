/**
 * TanStack Query hooks for the platform-admin notification-category
 * surface. The category list is small (≤50 rows in Phase 1) so we
 * don't bother with pagination — a single GET returns the lot.
 *
 * Mirrors the api-contracts schema as the single source of truth; do
 * NOT re-define category shapes here.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  NotificationCategoryResponse,
  UpdateNotificationCategoryInput,
} from '@insula/api-contracts';

interface Envelope<T> { readonly data: T }

export const NOTIFICATION_CATEGORIES_QUERY_KEY = ['notification-categories'] as const;

/** GET /api/v1/admin/notifications/categories — list all categories. */
export function useNotificationCategories() {
  return useQuery({
    queryKey: NOTIFICATION_CATEGORIES_QUERY_KEY,
    queryFn: () => apiFetch<Envelope<NotificationCategoryResponse[]>>(
      '/api/v1/admin/notifications/categories',
    ),
  });
}

/** PATCH /api/v1/admin/notifications/categories/:id — edit channels / rate limit / active flag. */
export function useUpdateNotificationCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { readonly id: string; readonly input: UpdateNotificationCategoryInput }) =>
      apiFetch<Envelope<NotificationCategoryResponse>>(
        `/api/v1/admin/notifications/categories/${encodeURIComponent(vars.id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(vars.input),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTIFICATION_CATEGORIES_QUERY_KEY });
    },
  });
}
