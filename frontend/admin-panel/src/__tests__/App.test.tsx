import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Layout from '../components/layout/Layout';

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: '1', email: 'a@b.com', fullName: 'Test', role: 'admin' },
    token: 't', isAuthenticated: true, isLoading: false, error: null,
    login: vi.fn(), logout: vi.fn(), initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-notifications', () => ({
  useNotifications: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useUnreadCount: vi.fn(() => ({ data: { data: { count: 0 } } })),
  useMarkNotificationsRead: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useMarkAllNotificationsRead: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteNotification: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('../hooks/use-dark-mode', () => ({
  useDarkMode: vi.fn(() => ({ theme: 'system', isDark: false, setTheme: vi.fn(), cycle: vi.fn() })),
}));

vi.mock('../hooks/use-password', () => ({
  useChangePassword: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));
import Placeholder from '../pages/Placeholder';

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement, route = '/') {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Layout', () => {
  it('renders sidebar and header', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('menu-button')).toBeInTheDocument();
  });

  // The nav must be its own scroll container. min-h-0 matters as much as
  // overflow-y-auto: a flex item defaults to min-height:auto and refuses to
  // shrink below its content, so without it the container never gets smaller
  // than what it holds and never scrolls — the nav just overflows the viewport
  // and the last entries become unreachable. The admin sidebar is the longer of
  // the two and has expandable groups, so it overflows first.
  it('sidebar nav scrolls when it outgrows the viewport', () => {
    renderWithProviders(<Layout />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.className).toContain('overflow-y-auto');
    expect(nav.className).toContain('min-h-0');
    expect(nav.className).toContain('flex-1');
  });

  it('shows sidebar nav items', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByText('Tenants')).toBeInTheDocument();
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
    expect(screen.getByText('Cluster')).toBeInTheDocument();
    expect(screen.getByText('Platform Settings')).toBeInTheDocument();
  });

  it('shows brand name', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByText('Insula')).toBeInTheDocument();
  });
});

describe('Placeholder', () => {
  it('renders with provided title', () => {
    renderWithProviders(<Placeholder title="Domains" />);
    expect(screen.getByText('Domains')).toBeInTheDocument();
    expect(screen.getByText('This page is under construction.')).toBeInTheDocument();
  });
});
