import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Notifications from '../pages/Notifications';

const mockNotifications = [
  {
    id: 'n-1',
    userId: 'u-1',
    type: 'info' as const,
    title: 'Welcome',
    message: 'Welcome to the platform',
    resourceType: null,
    resourceId: null,
    isRead: 0,
    readAt: null,
    createdAt: '2026-04-09T10:00:00.000Z',
  },
  {
    id: 'n-2',
    userId: 'u-1',
    type: 'warning' as const,
    title: 'Storage warning',
    message: 'You are using 85% of your storage quota',
    resourceType: 'storage',
    resourceId: 'volume-1',
    isRead: 0,
    readAt: null,
    createdAt: '2026-04-09T11:00:00.000Z',
  },
  {
    id: 'n-3',
    userId: 'u-1',
    type: 'success' as const,
    title: 'Backup complete',
    message: 'Your backup finished successfully',
    resourceType: 'backup',
    resourceId: 'backup-7',
    isRead: 1,
    readAt: '2026-04-09T11:30:00.000Z',
    createdAt: '2026-04-09T11:25:00.000Z',
  },
];

const markReadMutate = vi.fn();
const deleteMutate = vi.fn();
const markAllReadMutate = vi.fn();
const deleteAllMutate = vi.fn();
const markAllReadReset = vi.fn();
const deleteAllReset = vi.fn();

interface MockListHook {
  readonly data: { readonly data: readonly typeof mockNotifications[number][] };
  readonly isLoading: boolean;
  readonly isError: boolean;
}
interface MockMutHook {
  readonly mutate: typeof markReadMutate;
  readonly isPending: boolean;
}
/** The bulk hooks carry more surface than the per-row ones: the page reads
 *  `isSuccess`/`data` to report what was deleted, `isError` to explain a
 *  failure, and calls `reset()` so neither outlives the next action. */
interface MockBulkHook extends MockMutHook {
  readonly isError: boolean;
  readonly isSuccess: boolean;
  readonly data?: { readonly data: { readonly deleted: number } };
  readonly reset: () => void;
}

const listHook = vi.fn<() => MockListHook>(() => ({
  data: { data: mockNotifications },
  isLoading: false,
  isError: false,
}));
const unreadCountHook = vi.fn<() => { readonly data?: { readonly data: { readonly count: number } } }>(() => ({
  data: { data: { count: 2 } },
}));
const markReadHook = vi.fn<() => MockMutHook>(() => ({
  mutate: markReadMutate,
  isPending: false,
}));
const deleteHook = vi.fn<() => MockMutHook>(() => ({
  mutate: deleteMutate,
  isPending: false,
}));
const markAllReadHook = vi.fn<() => MockBulkHook>(() => ({
  mutate: markAllReadMutate,
  isPending: false,
  isError: false,
  isSuccess: false,
  reset: markAllReadReset,
}));
const deleteAllHook = vi.fn<() => MockBulkHook>(() => ({
  mutate: deleteAllMutate,
  isPending: false,
  isError: false,
  isSuccess: false,
  reset: deleteAllReset,
}));

vi.mock('../hooks/use-notifications', () => ({
  useNotifications: () => listHook(),
  useUnreadCount: () => unreadCountHook(),
  useMarkNotificationsRead: () => markReadHook(),
  useMarkAllNotificationsRead: () => markAllReadHook(),
  useDeleteNotification: () => deleteHook(),
  useDeleteAllNotifications: () => deleteAllHook(),
}));

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('Notifications page', () => {
  beforeEach(() => {
    listHook.mockReturnValue({
      data: { data: mockNotifications },
      isLoading: false,
      isError: false,
    });
    unreadCountHook.mockReturnValue({ data: { data: { count: 2 } } });
    markReadHook.mockReturnValue({ mutate: markReadMutate, isPending: false });
    deleteHook.mockReturnValue({ mutate: deleteMutate, isPending: false });
    markAllReadHook.mockReturnValue({
      mutate: markAllReadMutate, isPending: false, isError: false, isSuccess: false, reset: markAllReadReset,
    });
    deleteAllHook.mockReturnValue({
      mutate: deleteAllMutate, isPending: false, isError: false, isSuccess: false, reset: deleteAllReset,
    });
    markReadMutate.mockReset();
    deleteMutate.mockReset();
    markAllReadMutate.mockReset();
    deleteAllMutate.mockReset();
    markAllReadReset.mockReset();
    deleteAllReset.mockReset();
  });

  it('renders the heading and counts', () => {
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByTestId('notifications-heading')).toBeInTheDocument();
    expect(screen.getByTestId('notifications-count')).toHaveTextContent('3 shown');
    expect(screen.getByTestId('notifications-count')).toHaveTextContent('2 unread');
  });

  it('renders all notification rows', () => {
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByTestId('notification-n-1')).toBeInTheDocument();
    expect(screen.getByTestId('notification-n-2')).toBeInTheDocument();
    expect(screen.getByTestId('notification-n-3')).toBeInTheDocument();
    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(screen.getByText('Storage warning')).toBeInTheDocument();
    expect(screen.getByText('Backup complete')).toBeInTheDocument();
  });

  it('no longer offers a type filter', () => {
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('filter-type')).not.toBeInTheDocument();
    // Every type must still render — removing the filter must not have
    // removed the rows it used to select.
    expect(screen.getByTestId('notification-n-1')).toBeInTheDocument();
    expect(screen.getByTestId('notification-n-2')).toBeInTheDocument();
    expect(screen.getByTestId('notification-n-3')).toBeInTheDocument();
  });

  it('filters by read state', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.selectOptions(screen.getByTestId('filter-read'), 'unread');
    expect(screen.getByTestId('notifications-count')).toHaveTextContent('2 shown');
    expect(screen.queryByTestId('notification-n-3')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('filter-read'), 'read');
    expect(screen.getByTestId('notifications-count')).toHaveTextContent('1 shown');
    expect(screen.getByTestId('notification-n-3')).toBeInTheDocument();
    expect(screen.queryByTestId('notification-n-1')).not.toBeInTheDocument();
  });

  it('marks an individual notification as read', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('mark-read-n-1'));
    expect(markReadMutate).toHaveBeenCalledWith(['n-1']);
  });

  it('does not show mark-read button on already-read items', () => {
    render(<Notifications />, { wrapper: createWrapper() });
    const readRow = screen.getByTestId('notification-n-3');
    expect(within(readRow).queryByTestId('mark-read-n-3')).not.toBeInTheDocument();
  });

  it('shows the ACCOUNT-WIDE unread total, not the unread rows on screen', () => {
    // 3 rows fetched, 2 of them unread — but the account has 40. The list is
    // capped at 100, so deriving the number from the rows would disagree with
    // the bell badge and understate what the bulk action is about to touch.
    unreadCountHook.mockReturnValue({ data: { data: { count: 40 } } });
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByTestId('notifications-count')).toHaveTextContent('3 shown');
    expect(screen.getByTestId('notifications-count')).toHaveTextContent('40 unread');
  });

  it('marks all as read through the account-wide endpoint, with no ids', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('mark-all-read-button'));
    expect(markAllReadMutate).toHaveBeenCalledTimes(1);
    // Explicitly NOT the per-id variant: that one only covers the rows the
    // page happened to fetch and leaves the badge non-zero.
    expect(markReadMutate).not.toHaveBeenCalled();
  });

  it('disables Mark All As Read when nothing is unread', () => {
    unreadCountHook.mockReturnValue({ data: { data: { count: 0 } } });
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByTestId('mark-all-read-button')).toBeDisabled();
  });

  it('keeps Mark All As Read enabled while the filter hides every unread row', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.selectOptions(screen.getByTestId('filter-read'), 'read');
    // No unread row is on screen, but the account still has unread ones and
    // the action is account-wide.
    expect(screen.getByTestId('mark-all-read-button')).not.toBeDisabled();
  });

  // ─── Delete All ──────────────────────────────────────────────────────────

  it('requires confirmation before deleting everything', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('delete-all-button'));
    expect(deleteAllMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-delete-all')).toBeInTheDocument();
    // The confirmation must say the action reaches beyond the visible list.
    expect(screen.getByTestId('confirm-delete-all')).toHaveTextContent(/not listed here/i);
    await user.click(screen.getByTestId('confirm-delete-all-confirm'));
    expect(deleteAllMutate).toHaveBeenCalledTimes(1);
  });

  it('cancels the delete-all confirmation without firing the mutation', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('delete-all-button'));
    await user.click(screen.getByTestId('confirm-delete-all-cancel'));
    expect(deleteAllMutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-delete-all')).not.toBeInTheDocument();
    expect(screen.getByTestId('delete-all-button')).toBeInTheDocument();
  });

  it('disables Delete All when there is nothing to delete', () => {
    listHook.mockReturnValue({ data: { data: [] }, isLoading: false, isError: false });
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByTestId('delete-all-button')).toBeDisabled();
  });

  it('reports how many rows the server actually removed', () => {
    deleteAllHook.mockReturnValue({
      mutate: deleteAllMutate, isPending: false, isError: false, isSuccess: true,
      data: { data: { deleted: 147 } }, reset: deleteAllReset,
    });
    render(<Notifications />, { wrapper: createWrapper() });
    // 147, not the 3 rows the page had fetched — the count comes from the
    // server so a capped list can't understate it.
    expect(screen.getByTestId('delete-all-result')).toHaveTextContent('Deleted 147 notifications.');
  });

  it('clears a bulk receipt when the filter changes', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.selectOptions(screen.getByTestId('filter-read'), 'unread');
    // A receipt describing the previous action must not sit above a
    // re-filtered list as though it described the current one.
    expect(deleteAllReset).toHaveBeenCalled();
    expect(markAllReadReset).toHaveBeenCalled();
  });

  it('surfaces a failed bulk delete instead of silently doing nothing', () => {
    deleteAllHook.mockReturnValue({
      mutate: deleteAllMutate, isPending: false, isError: true, isSuccess: false, reset: deleteAllReset,
    });
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByTestId('bulk-action-error')).toHaveTextContent(/Could not delete all notifications/);
  });

  it('surfaces a failed mark-all-read', () => {
    markAllReadHook.mockReturnValue({
      mutate: markAllReadMutate, isPending: false, isError: true, isSuccess: false, reset: markAllReadReset,
    });
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByTestId('bulk-action-error')).toHaveTextContent(/Could not mark all as read/);
  });

  it('requires confirmation before deleting a notification', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('delete-notification-n-2'));
    // First click reveals confirm/cancel — does NOT fire mutate
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('confirm-delete-n-2')).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-delete-confirm-n-2'));
    expect(deleteMutate).toHaveBeenCalledWith('n-2');
  });

  it('cancels delete confirmation without firing the mutation', async () => {
    const user = userEvent.setup();
    render(<Notifications />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('delete-notification-n-1'));
    expect(screen.getByTestId('confirm-delete-n-1')).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-delete-cancel-n-1'));
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-delete-n-1')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no notifications', () => {
    listHook.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
    });
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByTestId('notifications-empty')).toBeInTheDocument();
    expect(screen.getByText(/No notifications yet/)).toBeInTheDocument();
  });

  it('shows a filter-specific empty message when the filter hides everything', async () => {
    const user = userEvent.setup();
    listHook.mockReturnValue({
      data: { data: [mockNotifications[2]] },  // the only read row
      isLoading: false,
      isError: false,
    });
    render(<Notifications />, { wrapper: createWrapper() });
    await user.selectOptions(screen.getByTestId('filter-read'), 'unread');
    expect(screen.getByTestId('notifications-empty')).toBeInTheDocument();
    expect(screen.getByText(/No notifications match/)).toBeInTheDocument();
  });

  it('shows the loading state', () => {
    listHook.mockReturnValue({
      data: undefined as unknown as { data: readonly typeof mockNotifications[number][] },
      isLoading: true,
      isError: false,
    });
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('notifications-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('notifications-empty')).not.toBeInTheDocument();
  });

  it('shows the error state', () => {
    listHook.mockReturnValue({
      data: undefined as unknown as { data: readonly typeof mockNotifications[number][] },
      isLoading: false,
      isError: true,
    });
    render(<Notifications />, { wrapper: createWrapper() });
    expect(screen.getByText(/Failed to load notifications/)).toBeInTheDocument();
  });
});
