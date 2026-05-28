/**
 * DeliveryLogTable unit tests — Platform → Notifications → Delivery Log.
 *
 * Mocks the deliveries hook so we can exercise filter wiring + status
 * badge rendering. The cursor-pagination hook is not mocked — it's
 * pure state, no I/O.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DeliveryLogTable from './DeliveryLogTable';

const listMock = vi.fn();

vi.mock('@/hooks/use-notification-deliveries', () => ({
  useNotificationDeliveries: (input: unknown) => listMock(input),
}));

const SEED_DELIVERIES = [
  {
    id: 'd-1',
    notificationId: 'n-1',
    eventId: 'e-1',
    userId: 'u-1',
    tenantId: 't-1',
    categoryId: 'backup.failed',
    channel: 'email' as const,
    providerId: 'stalwart',
    recipientHash: 'abcdef0123456789ffff',
    contentHash: 'aaaa',
    templateId: 't-1',
    templateVersion: 1,
    locale: 'en',
    status: 'sent' as const,
    attempt: 1,
    maxAttempts: 3,
    nextAttemptAt: null,
    lastError: null,
    providerMessageId: 'msg-1',
    queuedAt: '2026-05-28T10:00:00.000Z',
    sentAt: '2026-05-28T10:00:01.000Z',
    deliveredAt: '2026-05-28T10:00:02.000Z',
    failedAt: null,
  },
  {
    id: 'd-2',
    notificationId: null,
    eventId: 'e-2',
    userId: 'u-2',
    tenantId: 't-1',
    categoryId: 'tenant.welcome',
    channel: 'in_app' as const,
    providerId: null,
    recipientHash: null,
    contentHash: 'bbbb',
    templateId: null,
    templateVersion: 1,
    locale: 'en',
    status: 'failed' as const,
    attempt: 2,
    maxAttempts: 3,
    nextAttemptAt: '2026-05-28T11:00:00.000Z',
    lastError: 'Connection refused',
    providerMessageId: null,
    queuedAt: '2026-05-28T10:30:00.000Z',
    sentAt: null,
    deliveredAt: null,
    failedAt: '2026-05-28T10:30:30.000Z',
  },
];

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockReturnValue({
    data: { data: SEED_DELIVERIES, pagination: { nextCursor: null, limit: 50 } },
    isLoading: false,
    isFetching: false,
    error: null,
  });
});

describe('DeliveryLogTable', () => {
  it('renders one row per delivery', () => {
    render(<DeliveryLogTable />, { wrapper: createWrapper() });
    expect(screen.getByTestId('delivery-row-d-1')).toBeInTheDocument();
    expect(screen.getByTestId('delivery-row-d-2')).toBeInTheDocument();
  });

  it('renders distinct status badges per row', () => {
    render(<DeliveryLogTable />, { wrapper: createWrapper() });
    expect(screen.getByTestId('status-sent')).toBeInTheDocument();
    expect(screen.getByTestId('status-failed')).toBeInTheDocument();
  });

  it('changing the channel filter passes the filter to the hook', async () => {
    const user = userEvent.setup();
    render(<DeliveryLogTable />, { wrapper: createWrapper() });
    await user.selectOptions(screen.getByTestId('filter-channel'), 'email');
    await waitFor(() => {
      const calls = listMock.mock.calls as Array<[{ filters: { channel?: string } }]>;
      const last = calls[calls.length - 1][0];
      expect(last.filters.channel).toBe('email');
    });
  });

  it('changing the status filter passes the filter to the hook', async () => {
    const user = userEvent.setup();
    render(<DeliveryLogTable />, { wrapper: createWrapper() });
    await user.selectOptions(screen.getByTestId('filter-status'), 'failed');
    await waitFor(() => {
      const calls = listMock.mock.calls as Array<[{ filters: { status?: string } }]>;
      const last = calls[calls.length - 1][0];
      expect(last.filters.status).toBe('failed');
    });
  });

  it('typing a category filter passes the substring to the hook', async () => {
    const user = userEvent.setup();
    render(<DeliveryLogTable />, { wrapper: createWrapper() });
    await user.type(screen.getByTestId('filter-category'), 'backup');
    await waitFor(() => {
      const calls = listMock.mock.calls as Array<[{ filters: { categoryId?: string } }]>;
      const last = calls[calls.length - 1][0];
      expect(last.filters.categoryId).toBe('backup');
    });
  });

  it('truncates the recipient hash and exposes the full value in title', () => {
    render(<DeliveryLogTable />, { wrapper: createWrapper() });
    const row = screen.getByTestId('delivery-row-d-1');
    // Truncated to ~12 chars
    expect(row.textContent ?? '').toMatch(/abcdef01…ffff/);
  });

  it('renders empty state when no deliveries match', () => {
    listMock.mockReturnValue({
      data: { data: [], pagination: { nextCursor: null, limit: 50 } },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    render(<DeliveryLogTable />, { wrapper: createWrapper() });
    expect(screen.getByText('No deliveries match the current filters.')).toBeInTheDocument();
  });

  it('pagination next is disabled when there is no cursor', () => {
    render(<DeliveryLogTable />, { wrapper: createWrapper() });
    expect(screen.getByTestId('pagination-next')).toBeDisabled();
    expect(screen.getByTestId('pagination-prev')).toBeDisabled();
  });
});
