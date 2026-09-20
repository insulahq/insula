import { useState, useMemo } from 'react';
import {
  Bell,
  Info,
  AlertTriangle,
  XCircle,
  CheckCircle,
  Check,
  Trash2,
  Loader2,
} from 'lucide-react';
import clsx from 'clsx';
import {
  useNotifications,
  useUnreadCount,
  useMarkNotificationsRead,
  useMarkAllNotificationsRead,
  useDeleteNotification,
  useDeleteAllNotifications,
  type NotificationEntry,
} from '@/hooks/use-notifications';
import { formatRelativeTime } from '@/lib/format-relative-time';

/**
 * Round-4 Phase E: dedicated Notifications center page.
 *
 * Backed by the same hooks as the header dropdown but exposes a
 * larger limit, a read-state filter, account-wide bulk actions and
 * per-row actions (mark-read, delete). Linked from the dropdown's
 * "View all" affordance and the sidebar.
 *
 * The type filter was removed: with four types and a list this short
 * it only ever hid rows the reader had already scanned past, and the
 * icon in each row already carries the type at a glance.
 */
type FilterRead = 'all' | 'unread' | 'read';

const typeIcons = {
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
  success: CheckCircle,
} as const;

const typeColors = {
  info: 'text-blue-500 dark:text-blue-400',
  warning: 'text-amber-500 dark:text-amber-400',
  error: 'text-red-500 dark:text-red-400',
  success: 'text-green-500 dark:text-green-400',
} as const;

export default function Notifications() {
  // Round-4 Phase E: hardcoded limit=100. The notifications API
  // doesn't yet support pagination cursors — when it does, we'll
  // wire infinite scroll here.
  const { data, isLoading, isError } = useNotifications(100);
  const unreadCount = useUnreadCount();
  const markRead = useMarkNotificationsRead();
  const markAllRead = useMarkAllNotificationsRead();
  const deleteOne = useDeleteNotification();
  const deleteAll = useDeleteAllNotifications();

  const [filterRead, setFilterRead] = useState<FilterRead>('all');
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);

  const items = data?.data ?? [];

  const filtered = useMemo(() => {
    return items.filter((n) => {
      if (filterRead === 'unread' && n.isRead !== 0) return false;
      if (filterRead === 'read' && n.isRead === 0) return false;
      return true;
    });
  }, [items, filterRead]);

  // The account-wide unread total, not the unread count of the rows on
  // screen. The bulk actions below are account-wide, the bell badge reads
  // the same number, and the list is capped at 100 — deriving it from the
  // visible rows would make the three disagree the moment a user has more.
  const unreadTotal = unreadCount.data?.data.count ?? 0;

  const deletedCount = deleteAll.isSuccess ? deleteAll.data?.data.deleted ?? 0 : null;

  // A receipt or an error from a bulk action describes the action the reader
  // just took, so it must not outlive the next one — a stale "Deleted 12"
  // sitting above a full list reads as the current state of the account.
  const clearBulkState = () => {
    markAllRead.reset();
    deleteAll.reset();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Bell size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="notifications-heading">
          Notifications
        </h1>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        Full history of platform notifications for this account. New events
        also appear in the bell menu in the page header.
      </p>

      {/* Filter + account-wide actions */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
        data-testid="notifications-filters"
      >
        <label htmlFor="notif-read" className="text-xs font-medium text-gray-500 dark:text-gray-400">
          Read state
        </label>
        <select
          id="notif-read"
          value={filterRead}
          onChange={(e) => {
            setFilterRead(e.target.value as FilterRead);
            clearBulkState();
          }}
          className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-sm text-gray-700 dark:text-gray-200"
          data-testid="filter-read"
        >
          <option value="all">All</option>
          <option value="unread">Unread only</option>
          <option value="read">Read only</option>
        </select>

        <span
          className="text-xs text-gray-500 dark:text-gray-400"
          title="Rows matching the filter, and the unread total for this account"
          data-testid="notifications-count"
        >
          {filtered.length} shown · {unreadTotal} unread
        </span>

        <div className="ml-auto flex items-center gap-2">
          {deletedCount !== null && (
            <span className="text-xs text-gray-500 dark:text-gray-400" data-testid="delete-all-result">
              Deleted {deletedCount} notification{deletedCount === 1 ? '' : 's'}.
            </span>
          )}

          <button
            type="button"
            onClick={() => {
              deleteAll.reset();
              markAllRead.mutate();
            }}
            disabled={markAllRead.isPending || unreadTotal === 0}
            title="Marks every unread notification on this account, including any not listed here"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="mark-all-read-button"
          >
            {markAllRead.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            Mark All As Read
          </button>

          {confirmingDeleteAll ? (
            <div className="flex items-center gap-2" data-testid="confirm-delete-all">
              <span className="text-xs text-gray-600 dark:text-gray-300">
                Delete every notification, including any not listed here? This cannot be undone.
              </span>
              <button
                type="button"
                onClick={() => {
                  markAllRead.reset();
                  deleteAll.mutate();
                  setConfirmingDeleteAll(false);
                }}
                disabled={deleteAll.isPending}
                className="rounded-md bg-red-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                data-testid="confirm-delete-all-confirm"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDeleteAll(false)}
                disabled={deleteAll.isPending}
                className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                data-testid="confirm-delete-all-cancel"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                clearBulkState();
                setConfirmingDeleteAll(true);
              }}
              disabled={deleteAll.isPending || items.length === 0}
              title="Deletes every notification on this account, including any not listed here"
              className="inline-flex items-center gap-1.5 rounded-md border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="delete-all-button"
            >
              {deleteAll.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Delete All
            </button>
          )}
        </div>
      </div>

      {(markAllRead.isError || deleteAll.isError) && (
        <div
          className="rounded-xl border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-5 py-3 text-sm text-red-700 dark:text-red-300"
          data-testid="bulk-action-error"
        >
          {markAllRead.isError ? 'Could not mark all as read.' : 'Could not delete all notifications.'}{' '}
          Nothing was changed — try again.
        </div>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-brand-500" />
        </div>
      )}

      {!isLoading && isError && (
        <div className="rounded-xl border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-5 py-4 text-sm text-red-700 dark:text-red-300">
          Failed to load notifications.
        </div>
      )}

      {!isLoading && !isError && filtered.length === 0 && (
        <div
          className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-5 py-12 text-center"
          data-testid="notifications-empty"
        >
          <Bell size={36} className="mx-auto text-gray-300 dark:text-gray-600" />
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            {filterRead !== 'all'
              ? 'No notifications match the current filter.'
              : 'No notifications yet.'}
          </p>
        </div>
      )}

      {!isLoading && !isError && filtered.length > 0 && (
        <div
          className="divide-y divide-gray-100 dark:divide-gray-700 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm"
          data-testid="notifications-list"
        >
          {filtered.map((n) => (
            <NotificationRow
              key={n.id}
              notification={n}
              onMarkRead={() => markRead.mutate([n.id])}
              onDelete={() => deleteOne.mutate(n.id)}
              markReadPending={markRead.isPending && Array.isArray(markRead.variables) && markRead.variables.includes(n.id)}
              deletePending={deleteOne.isPending && deleteOne.variables === n.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  notification,
  onMarkRead,
  onDelete,
  markReadPending,
  deletePending,
}: {
  readonly notification: NotificationEntry;
  readonly onMarkRead: () => void;
  readonly onDelete: () => void;
  readonly markReadPending: boolean;
  readonly deletePending: boolean;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const Icon = typeIcons[notification.type] ?? Info;
  const color = typeColors[notification.type] ?? 'text-gray-400';
  const isUnread = notification.isRead === 0;

  return (
    <div
      className={clsx(
        'flex items-start gap-3 px-5 py-4',
        isUnread && 'bg-brand-50/30 dark:bg-brand-900/10',
      )}
      data-testid={`notification-${notification.id}`}
    >
      <Icon size={18} className={`mt-0.5 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {notification.title}
          </p>
          {isUnread && (
            <span className="inline-flex items-center rounded-full bg-brand-100 dark:bg-brand-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700 dark:text-brand-300">
              new
            </span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">{notification.message}</p>
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
          {formatRelativeTime(notification.createdAt)}
          {notification.resourceType && (
            <span className="ml-2 inline-flex items-center rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] font-mono">
              {notification.resourceType}
            </span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1">
        {isUnread && !confirmingDelete && (
          <button
            type="button"
            onClick={onMarkRead}
            disabled={markReadPending}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-brand-500 disabled:opacity-50"
            aria-label="Mark as read"
            title="Mark as read"
            data-testid={`mark-read-${notification.id}`}
          >
            <Check size={14} />
          </button>
        )}
        {confirmingDelete ? (
          <div className="flex items-center gap-1" data-testid={`confirm-delete-${notification.id}`}>
            <button
              type="button"
              onClick={() => {
                onDelete();
                setConfirmingDelete(false);
              }}
              disabled={deletePending}
              className="rounded-md bg-red-500 px-2 py-1 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50"
              data-testid={`confirm-delete-confirm-${notification.id}`}
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={deletePending}
              className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              data-testid={`confirm-delete-cancel-${notification.id}`}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={deletePending}
            className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 disabled:opacity-50"
            aria-label="Delete notification"
            title="Delete notification"
            data-testid={`delete-notification-${notification.id}`}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
