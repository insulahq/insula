import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UpdateBanner from '../components/UpdateBanner';

const mockUpdateSettingsMutate = vi.fn();

const mockVersionData = {
  data: {
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    environment: 'production',
    autoUpdate: false,
    lastCheckedAt: '2026-03-28T12:00:00Z',
  },
};

const mockVersionNoUpdate = {
  data: {
    currentVersion: '0.2.0',
    latestVersion: '0.2.0',
    updateAvailable: false,
    environment: 'production',
    autoUpdate: true,
    lastCheckedAt: '2026-03-28T12:00:00Z',
  },
};

vi.mock('../hooks/use-platform-updates', () => ({
  usePlatformVersion: vi.fn(() => ({
    data: mockVersionData,
    isLoading: false,
    refetch: vi.fn(),
  })),
  useUpdateSettings: vi.fn(() => ({
    mutate: mockUpdateSettingsMutate,
    isPending: false,
    isSuccess: false,
    isError: false,
  })),
}));

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'admin-1', email: 'admin@k8s-platform.test', fullName: 'Admin User', role: 'admin' },
    token: 'test-token', isAuthenticated: true, isLoading: false, error: null,
    login: vi.fn(), logout: vi.fn(), initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-dashboard', () => ({
  usePlatformStatus: vi.fn(() => ({
    data: { data: { status: 'healthy', version: '0.1.0', timestamp: '2026-03-27T00:00:00Z' } },
    isLoading: false,
  })),
}));

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
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UpdateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when update is available', () => {
    renderWithProviders(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toBeInTheDocument();
    expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByText(/0\.1\.0/)).toBeInTheDocument();
  });

  it('does not render when no update is available', async () => {
    const mod = await import('../hooks/use-platform-updates');
    vi.mocked(mod.usePlatformVersion).mockReturnValue({
      data: mockVersionNoUpdate,
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof mod.usePlatformVersion>);

    const { container } = renderWithProviders(<UpdateBanner />);
    expect(container.querySelector('[data-testid="update-banner"]')).toBeNull();

    // Reset mock for subsequent tests
    vi.mocked(mod.usePlatformVersion).mockReturnValue({
      data: mockVersionData,
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof mod.usePlatformVersion>);
  });

  it('admin sees a "View details" link (not the apply action)', () => {
    renderWithProviders(<UpdateBanner />);
    expect(screen.getByTestId('update-banner-details')).toHaveAttribute('href', '/platform/updates');
    expect(screen.queryByTestId('update-banner-review')).toBeNull();
  });

  it('super_admin sees "Review & apply" linking to the Upgrades page', async () => {
    const auth = await import('../hooks/use-auth');
    vi.mocked(auth.useAuth).mockReturnValueOnce({
      user: { id: 'sa-1', email: 'sa@k8s-platform.test', fullName: 'SA', role: 'super_admin' },
      token: 't', isAuthenticated: true, isLoading: false, error: null,
      login: vi.fn(), logout: vi.fn(), initialize: vi.fn(),
    } as unknown as ReturnType<typeof auth.useAuth>);
    renderWithProviders(<UpdateBanner />);
    expect(screen.getByTestId('update-banner-review')).toHaveAttribute('href', '/platform/updates');
  });

  it('"Dismiss" hides the banner', async () => {
    renderWithProviders(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('update-banner-dismiss'));
    await waitFor(() => {
      expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
    });
  });
});

// The version card + auto-update toggle moved into the consolidated Upgrades
// page (src/__tests__/upgrades-page.test.tsx covers them there).
