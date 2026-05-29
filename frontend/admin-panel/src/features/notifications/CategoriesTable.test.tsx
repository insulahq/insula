/**
 * CategoriesTable unit tests — Platform → Notifications → Categories.
 *
 * Mocks the two TanStack Query hooks (list + update) directly so we can
 * exercise the table render, edit-drawer open, and save flow without
 * standing up a fake API.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CategoriesTable from './CategoriesTable';

const listMock = vi.fn();
const updateMutate = vi.fn();

vi.mock('@/hooks/use-notification-categories', () => ({
  useNotificationCategories: () => listMock(),
  useUpdateNotificationCategory: () => ({
    mutateAsync: updateMutate,
    isPending: false,
    error: null,
  }),
}));

const SEED_CATEGORIES = [
  {
    id: 'backup.failed',
    displayName: 'Backup Failed',
    description: 'Tenant nightly backup did not complete',
    audience: 'tenant' as const,
    defaultSeverity: 'error' as const,
    defaultChannels: ['email' as const, 'in_app' as const],
    isMandatory: true,
    gdprBasis: 'contract' as const,
    rateLimitWindowS: 3600,
    rateLimitMax: 1,
    isActive: true,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'tenant.welcome',
    displayName: 'Tenant Welcome',
    description: null,
    audience: 'tenant' as const,
    defaultSeverity: 'info' as const,
    defaultChannels: ['email' as const],
    isMandatory: false,
    gdprBasis: 'contract' as const,
    rateLimitWindowS: null,
    rateLimitMax: null,
    isActive: true,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
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
    data: { data: SEED_CATEGORIES },
    isLoading: false,
    error: null,
  });
  updateMutate.mockResolvedValue({ data: SEED_CATEGORIES[0] });
});

describe('CategoriesTable', () => {
  it('renders one row per category', () => {
    render(<CategoriesTable />, { wrapper: createWrapper() });
    expect(screen.getByTestId('category-row-backup.failed')).toBeInTheDocument();
    expect(screen.getByTestId('category-row-tenant.welcome')).toBeInTheDocument();
    expect(screen.getByText('Backup Failed')).toBeInTheDocument();
  });

  it('shows the mandatory lock for mandatory categories', () => {
    render(<CategoriesTable />, { wrapper: createWrapper() });
    expect(screen.getByText('mandatory')).toBeInTheDocument();
  });

  it('renders rate-limit text when set', () => {
    render(<CategoriesTable />, { wrapper: createWrapper() });
    expect(screen.getByText('1 / 3600s')).toBeInTheDocument();
  });

  it('opens the edit drawer when a row is clicked', async () => {
    const user = userEvent.setup();
    render(<CategoriesTable />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('category-row-tenant.welcome'));
    expect(screen.getByTestId('category-edit-drawer')).toBeInTheDocument();
    expect(screen.getByText(/Edit Source — Tenant Welcome/)).toBeInTheDocument();
  });

  it('save calls the update mutation with the edited input', async () => {
    const user = userEvent.setup();
    render(<CategoriesTable />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('category-row-tenant.welcome'));
    // Toggle in_app on (it was off by default for welcome)
    await user.click(screen.getByTestId('channel-checkbox-in_app'));
    await user.click(screen.getByTestId('category-save'));
    await waitFor(() => {
      expect(updateMutate).toHaveBeenCalledTimes(1);
    });
    const call = updateMutate.mock.calls[0][0] as { id: string; input: { defaultChannels?: string[] } };
    expect(call.id).toBe('tenant.welcome');
    expect(call.input.defaultChannels).toContain('in_app');
    expect(call.input.defaultChannels).toContain('email');
  });

  it('renders empty state when category list is empty', () => {
    listMock.mockReturnValue({ data: { data: [] }, isLoading: false, error: null });
    render(<CategoriesTable />, { wrapper: createWrapper() });
    expect(screen.getByText('No notification sources defined.')).toBeInTheDocument();
  });
});
