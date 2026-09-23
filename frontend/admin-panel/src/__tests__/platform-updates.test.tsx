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

  it('renders when update is available, with leading v on both versions', () => {
    renderWithProviders(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toBeInTheDocument();
    expect(screen.getByText(/v0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByText(/v0\.1\.0/)).toBeInTheDocument();
  });

  it('shows the VERIFIED available version, not the unverified latest mirror', async () => {
    // `updateAvailable` is computed from `available` (cosign-verified, written
    // by the hourly poller). The banner rendered `latestVersion`, a lazily
    // refreshed mirror the poller never writes — so on production it read
    // "update available: 2026.9.30 (current: 2026.9.30)" while the verified
    // value was 2026.9.31. Deciding from one field and captioning from another
    // is how a banner contradicts itself.
    const mod = await import('../hooks/use-platform-updates');
    vi.mocked(mod.usePlatformVersion).mockReturnValue({
      data: {
        data: {
          currentVersion: '2026.9.30',
          installed: '2026.9.30',
          latestVersion: '2026.9.30',   // stale mirror
          available: '2026.9.31',       // verified, authoritative
          updateAvailable: true,
          environment: 'production',
          autoUpdate: false,
          lastCheckedAt: '2026-09-23T18:42:55Z',
        },
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof mod.usePlatformVersion>);

    renderWithProviders(<UpdateBanner />);
    const banner = screen.getByTestId('update-banner');
    expect(banner.textContent).toContain('v2026.9.31');
    expect(banner.textContent).toMatch(/current: v2026\.9\.30/);
    // The old wording — available and current identical — must not reappear.
    expect(banner.textContent).not.toMatch(/available: v2026\.9\.30/);
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

  // `?review=1` is the whole point of this link, not incidental: it is what makes
  // the Updates page open the review modal on arrival instead of dropping the
  // operator on the page to find the same button. Asserted exactly, so removing
  // the param silently reverts the behaviour and fails here.
  it('super_admin sees "Review & apply" linking straight into the review modal', async () => {
    const auth = await import('../hooks/use-auth');
    vi.mocked(auth.useAuth).mockReturnValueOnce({
      user: { id: 'sa-1', email: 'sa@k8s-platform.test', fullName: 'SA', role: 'super_admin' },
      token: 't', isAuthenticated: true, isLoading: false, error: null,
      login: vi.fn(), logout: vi.fn(), initialize: vi.fn(),
    } as unknown as ReturnType<typeof auth.useAuth>);
    renderWithProviders(<UpdateBanner />);
    expect(screen.getByTestId('update-banner-review')).toHaveAttribute('href', '/platform/updates?review=1');
  });

  // The non-apply audience must NOT be sent into the apply flow: the modal's only
  // action is super_admin-only and server-enforced, so opening it for an admin
  // would present a button that cannot work.
  it('admin\'s "View details" link carries no review param', () => {
    renderWithProviders(<UpdateBanner />);
    expect(screen.getByTestId('update-banner-details')).toHaveAttribute('href', '/platform/updates');
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
