import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Dashboard from '../pages/Dashboard';

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'tenant-1', email: 'test@example.com', fullName: 'Test User', role: 'tenant' },
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
    initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-tenant-context', () => ({
  useTenantContext: vi.fn(() => ({ tenantId: 'c1', tenantName: 'Test', isLoading: false })),
}));

vi.mock('../hooks/use-domains', () => ({
  useDomains: vi.fn(() => ({ data: { data: [] } })),
}));

vi.mock('../hooks/use-backups', () => ({
  useBackups: vi.fn(() => ({ data: { data: [] } })),
}));

vi.mock('../hooks/use-deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-deployments')>();
  return {
    ...actual,
    useDeployments: vi.fn(() => ({ data: { data: [] } })),
  };
});

// The dashboard reads the SAME endpoint as the Resource Usage page and the
// metrics modal. Values below are the operator-reported case: 6 GiB of a 10 GiB
// storage plan, which is 60% and must NOT render as a warning.
vi.mock('../hooks/use-resource-metrics', () => ({
  useResourceMetrics: vi.fn(() => ({
    data: {
      data: {
        tenantId: 't1',
        cpu: { inUse: 0.25, reserved: 0.5, available: 2 },
        memory: { inUse: 1.5, reserved: 2, available: 4 },
        storage: { inUse: 6, reserved: 8, available: 10 },
        lastUpdatedAt: '2026-08-30T00:00:00.000Z',
      },
    },
    isLoading: false,
  })),
}));

vi.mock('../hooks/use-email', () => ({
  useMailboxUsage: vi.fn(() => ({
    data: { data: { limit: 50, current: 3, remaining: 47, source: 'plan' } },
    isLoading: false,
  })),
}));

import { useAuth } from '../hooks/use-auth';

const mockedUseAuth = vi.mocked(useAuth);

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Dashboard Page', () => {
  it('renders welcome heading with user name', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId('welcome-heading')).toBeInTheDocument();
    expect(screen.getByText(/Welcome back, Test User/)).toBeInTheDocument();
  });

  it('renders overview description', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByText('Here is an overview of your hosting account.')).toBeInTheDocument();
  });

  it('renders quick stats grid with all five cards including Email accounts', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId('quick-stats')).toBeInTheDocument();
    expect(screen.getByText('Domains')).toBeInTheDocument();
    expect(screen.getByText('Applications')).toBeInTheDocument();
    expect(screen.getByText('Backups')).toBeInTheDocument();
    expect(screen.getByText('Deployments')).toBeInTheDocument();
    expect(screen.getByText('Email accounts')).toBeInTheDocument();
  });

  it('shows mailbox usage count in the Email accounts tile', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId('stat-email accounts')).toHaveTextContent('3/50');
  });

  it('shows zero values in non-email stats cards when no data', () => {
    renderWithProviders(<Dashboard />);
    // Four stat cards (Domains, Applications, Backups, Deployments) default
    // to 0; Email accounts is driven by useMailboxUsage mock.
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBe(4);
  });

  it('renders overview description under the welcome heading', () => {
    renderWithProviders(<Dashboard />);
    expect(
      screen.getByText(/Here is an overview of your hosting account/),
    ).toBeInTheDocument();
  });

  it('shows email as fallback when fullName is null', () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'tenant-1', email: 'jane@example.com', fullName: null, role: 'tenant' },
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
      initialize: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    renderWithProviders(<Dashboard />);
    expect(screen.getByText(/Welcome back, jane@example.com/)).toBeInTheDocument();
  });

  it('shows "there" when both fullName and email are missing', () => {
    mockedUseAuth.mockReturnValue({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
      initialize: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    renderWithProviders(<Dashboard />);
    expect(screen.getByText(/Welcome back, there/)).toBeInTheDocument();
  });

  it('shows used / reserved / available on every resource tile', () => {
    renderWithProviders(<Dashboard />);
    for (const testId of ['dashboard-cpu-bar', 'dashboard-memory-bar', 'dashboard-storage-bar']) {
      const tile = screen.getByTestId(testId);
      expect(tile.textContent).toContain('used');
      expect(tile.textContent).toContain('reserved');
      expect(tile.textContent).toContain('available');
    }
  });

  it('renders the storage tile at 60% of plan WITHOUT a warning colour', () => {
    // The reported bug: storage was hardcoded amber, so 6 GB of a 10 GB plan
    // looked like a warning. Amber must not appear below the 80% threshold.
    renderWithProviders(<Dashboard />);
    const tile = screen.getByTestId('dashboard-storage-bar');
    const bars = tile.querySelectorAll('div[style*="width"]');
    const classes = Array.from(bars).map((b) => b.className).join(' ');
    expect(classes).toContain('bg-brand-500');
    expect(classes).not.toContain('bg-amber');
    expect(classes).not.toContain('bg-red');
    expect(tile.textContent).toContain('60%');
  });

  it('shows the reserved figure that explains a refused deployment', () => {
    // reserved (8) exceeds in-use (6): the tenant has headroom by usage but not
    // by allocation. That number was absent from the dashboard entirely.
    renderWithProviders(<Dashboard />);
    const tile = screen.getByTestId('dashboard-storage-bar');
    expect(tile.textContent).toContain('8');
  });
});
