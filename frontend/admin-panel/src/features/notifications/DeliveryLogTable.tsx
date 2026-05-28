/**
 * Notification Delivery Log — Platform → Notifications → Delivery Log.
 *
 * Operator triage surface for the per-channel delivery outcomes. Backend
 * caps `limit` at 100 and exposes a cursor for the next page. Filters
 * narrow by channel / status / categoryId / tenantId / sinceSeconds.
 *
 * Recipient + content are hashes (GDPR) — we surface the truncated
 * hash with a hover-title revealing the full string.
 */

import { useState } from 'react';
import { Loader2, ChevronLeft, ChevronRight, RotateCw } from 'lucide-react';
import {
  useNotificationDeliveries,
  useRetryNotificationDelivery,
  type NotificationDeliveryFilters,
} from '@/hooks/use-notification-deliveries';
import { useCursorPagination } from '@/hooks/use-cursor-pagination';
import {
  NOTIFICATION_CHANNEL_ID,
  NOTIFICATION_DELIVERY_STATUS,
  type NotificationChannelId,
  type NotificationDeliveryStatus,
  type NotificationDeliveryResponse,
} from '@k8s-hosting/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

const STATUS_BADGE: Record<NotificationDeliveryStatus, string> = {
  queued: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  sending: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  sent: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  dlq: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  skipped: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  rate_limited: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  muted: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
};

const SINCE_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: number | undefined }> = [
  { label: 'All available', value: undefined },
  { label: 'Last 5 min', value: 5 * 60 },
  { label: 'Last hour', value: 60 * 60 },
  { label: 'Last day', value: 24 * 60 * 60 },
  { label: 'Last 7 days', value: 7 * 24 * 60 * 60 },
];

function truncateHash(hash: string | null): string {
  if (!hash) return '—';
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

export default function DeliveryLogTable() {
  const [channel, setChannel] = useState<NotificationChannelId | undefined>(undefined);
  const [status, setStatus] = useState<NotificationDeliveryStatus | undefined>(undefined);
  const [categoryId, setCategoryId] = useState<string>('');
  const [tenantId, setTenantId] = useState<string>('');
  const [sinceSeconds, setSinceSeconds] = useState<number | undefined>(60 * 60);

  const pagination = useCursorPagination({ defaultLimit: 50 });

  const filters: NotificationDeliveryFilters = {
    channel,
    status,
    categoryId: categoryId.trim() || undefined,
    tenantId: tenantId.trim() || undefined,
    sinceSeconds,
  };

  const list = useNotificationDeliveries({
    filters,
    cursor: pagination.cursor,
    limit: pagination.limit,
  });

  const retry = useRetryNotificationDelivery();
  const onRetry = async (deliveryId: string): Promise<void> => {
    try { await retry.mutateAsync(deliveryId); } catch { /* surfaced */ }
  };

  // Whenever a filter changes, drop back to page 0.
  const resetAndSet = <T,>(setter: (v: T) => void) => (v: T): void => {
    setter(v);
    pagination.resetPagination();
  };

  const nextCursor = list.data?.pagination?.nextCursor ?? null;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <section className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3 text-xs dark:border-gray-700 dark:bg-gray-800">
        <label className="flex items-center gap-1">
          <span className="text-gray-600 dark:text-gray-300">Channel</span>
          <select
            value={channel ?? ''}
            onChange={(e) => resetAndSet(setChannel)((e.target.value || undefined) as NotificationChannelId | undefined)}
            data-testid="filter-channel"
            className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">all</option>
            {NOTIFICATION_CHANNEL_ID.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-600 dark:text-gray-300">Status</span>
          <select
            value={status ?? ''}
            onChange={(e) => resetAndSet(setStatus)((e.target.value || undefined) as NotificationDeliveryStatus | undefined)}
            data-testid="filter-status"
            className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">all</option>
            {NOTIFICATION_DELIVERY_STATUS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-600 dark:text-gray-300">Category</span>
          <input
            type="text"
            placeholder="e.g. backup.failed"
            value={categoryId}
            onChange={(e) => resetAndSet(setCategoryId)(e.target.value)}
            data-testid="filter-category"
            className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-600 dark:text-gray-300">Tenant ID</span>
          <input
            type="text"
            value={tenantId}
            onChange={(e) => resetAndSet(setTenantId)(e.target.value)}
            data-testid="filter-tenant"
            className="w-40 rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-600 dark:text-gray-300">Since</span>
          <select
            value={sinceSeconds ?? ''}
            onChange={(e) => resetAndSet(setSinceSeconds)(e.target.value === '' ? undefined : Number.parseInt(e.target.value, 10))}
            data-testid="filter-since"
            className="rounded border border-gray-300 px-2 py-1 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            {SINCE_OPTIONS.map((o) => (
              <option key={o.label} value={o.value ?? ''}>{o.label}</option>
            ))}
          </select>
        </label>
      </section>

      {list.error && (
        <ErrorPanel
          error={extractOperatorError(list.error)}
          severity="error"
          testId="deliveries-list-error"
        />
      )}

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2 dark:border-gray-700">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Deliveries ({list.data?.data.length ?? 0})
          </h2>
          <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <button
              type="button"
              onClick={pagination.goPrev}
              disabled={!pagination.hasPrevPage || list.isFetching}
              data-testid="pagination-prev"
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              <ChevronLeft size={12} /> Prev
            </button>
            <span>Page {pagination.pageIndex + 1}</span>
            <button
              type="button"
              onClick={() => nextCursor && pagination.goNext(nextCursor)}
              disabled={!nextCursor || list.isFetching}
              data-testid="pagination-next"
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              Next <ChevronRight size={12} />
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-500 dark:text-gray-400">
              <tr className="border-b border-gray-200/60 dark:border-gray-700/40">
                <th className="px-4 py-2 text-left">Queued At</th>
                <th className="px-4 py-2 text-left">Channel</th>
                <th className="px-4 py-2 text-left">Category</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Recipient Hash</th>
                <th className="px-4 py-2 text-right">Attempt</th>
                <th className="px-4 py-2 text-left">Last Error</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                    <Loader2 size={16} className="mx-auto animate-spin" />
                  </td>
                </tr>
              )}
              {!list.isLoading && (list.data?.data.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-3 text-center text-gray-500">
                    No deliveries match the current filters.
                  </td>
                </tr>
              )}
              {list.data?.data.map((d: NotificationDeliveryResponse) => (
                <tr
                  key={d.id}
                  className="border-t border-gray-200/60 dark:border-gray-700/40"
                  data-testid={`delivery-row-${d.id}`}
                >
                  <td className="whitespace-nowrap px-4 py-2 text-gray-700 dark:text-gray-200">
                    {new Date(d.queuedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{d.channel}</td>
                  <td className="px-4 py-2 font-mono text-gray-700 dark:text-gray-200">{d.categoryId}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[d.status]}`}
                      data-testid={`status-${d.status}`}
                    >
                      {d.status}
                    </span>
                  </td>
                  <td
                    className="px-4 py-2 font-mono text-[10px] text-gray-600 dark:text-gray-300"
                    title={d.recipientHash ?? undefined}
                  >
                    {truncateHash(d.recipientHash)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-700 dark:text-gray-200">
                    {d.attempt}/{d.maxAttempts}
                  </td>
                  <td className="max-w-xs truncate px-4 py-2 text-red-700 dark:text-red-400" title={d.lastError ?? undefined}>
                    {d.lastError ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {(d.status === 'failed' || d.status === 'dlq') && d.channel === 'email' && (
                      <button
                        type="button"
                        onClick={() => onRetry(d.id)}
                        disabled={retry.isPending}
                        data-testid={`retry-${d.id}`}
                        title="Re-queue this delivery for the email worker"
                        className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-[10px] hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
                      >
                        {retry.isPending ? <Loader2 size={10} className="animate-spin" /> : <RotateCw size={10} />}
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
