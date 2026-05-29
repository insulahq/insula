/**
 * TanStack Query hooks for the platform-admin notification-template
 * editor surface. Templates are Handlebars sources keyed by
 * (categoryId, channel, locale); the list supports filter narrowing
 * by category + channel.
 *
 * Preview is a non-mutating POST — we don't invalidate caches; the UI
 * just renders the response inline.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  NotificationTemplateResponse,
  UpdateNotificationTemplateInput,
  PreviewNotificationTemplateInput,
  PreviewNotificationTemplateResponse,
  NotificationChannelId,
} from '@insula/api-contracts';

interface Envelope<T> { readonly data: T }

export const NOTIFICATION_TEMPLATES_QUERY_KEY = ['notification-templates'] as const;

export interface NotificationTemplatesFilters {
  readonly categoryId?: string;
  readonly channel?: NotificationChannelId;
}

function buildQs(filters: NotificationTemplatesFilters): string {
  const p = new URLSearchParams();
  if (filters.categoryId) p.set('categoryId', filters.categoryId);
  if (filters.channel) p.set('channel', filters.channel);
  const q = p.toString();
  return q ? `?${q}` : '';
}

/** GET /api/v1/admin/notifications/templates — list (optionally filtered). */
export function useNotificationTemplates(filters: NotificationTemplatesFilters = {}) {
  return useQuery({
    queryKey: [...NOTIFICATION_TEMPLATES_QUERY_KEY, filters.categoryId ?? null, filters.channel ?? null],
    queryFn: () => apiFetch<Envelope<NotificationTemplateResponse[]>>(
      `/api/v1/admin/notifications/templates${buildQs(filters)}`,
    ),
  });
}

/** GET /api/v1/admin/notifications/templates/:id — single template (full body). */
export function useNotificationTemplate(id: string | null) {
  return useQuery({
    queryKey: [...NOTIFICATION_TEMPLATES_QUERY_KEY, 'detail', id],
    queryFn: () => apiFetch<Envelope<NotificationTemplateResponse>>(
      `/api/v1/admin/notifications/templates/${encodeURIComponent(id!)}`,
    ),
    enabled: !!id,
  });
}

/** PATCH /api/v1/admin/notifications/templates/:id — save edits. */
export function useUpdateNotificationTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { readonly id: string; readonly input: UpdateNotificationTemplateInput }) =>
      apiFetch<Envelope<NotificationTemplateResponse>>(
        `/api/v1/admin/notifications/templates/${encodeURIComponent(vars.id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(vars.input),
        },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: NOTIFICATION_TEMPLATES_QUERY_KEY });
      qc.invalidateQueries({ queryKey: [...NOTIFICATION_TEMPLATES_QUERY_KEY, 'detail', vars.id] });
    },
  });
}

/** POST /api/v1/admin/notifications/templates/:id/preview — render with sample vars. */
export function usePreviewNotificationTemplate() {
  return useMutation({
    mutationFn: (vars: { readonly id: string; readonly input: PreviewNotificationTemplateInput }) =>
      apiFetch<Envelope<PreviewNotificationTemplateResponse>>(
        `/api/v1/admin/notifications/templates/${encodeURIComponent(vars.id)}/preview`,
        {
          method: 'POST',
          body: JSON.stringify(vars.input),
        },
      ),
  });
}

/** POST /api/v1/admin/notifications/templates/:id/restore-seed — revert to stock template. */
export function useRestoreNotificationTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Envelope<NotificationTemplateResponse>>(
        `/api/v1/admin/notifications/templates/${encodeURIComponent(id)}/restore-seed`,
        { method: 'POST' },
      ),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: NOTIFICATION_TEMPLATES_QUERY_KEY });
      qc.invalidateQueries({ queryKey: [...NOTIFICATION_TEMPLATES_QUERY_KEY, 'detail', id] });
    },
  });
}
