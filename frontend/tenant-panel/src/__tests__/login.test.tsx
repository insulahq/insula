import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Login from '../pages/Login';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

function createWrapper(initialEntries: string[] = ['/login']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockResolvedValue({ data: { localAuthEnabled: true, providers: [] } });
});

// ── No auto-forward to the IdP ──────────────────────────────────────────────
// Single provider + local auth disabled used to auto-redirect on a 500ms timer.
// That made the page a dead end: a visitor who had just signed out was thrown
// straight back into the IdP (which still held its own session) with no way to
// reach the page and switch accounts, and any ?error= from the callback was
// invisible because the redirect fired before it could be read.
describe('tenant login — single OIDC provider, local auth disabled', () => {
  const singleProvider = {
    data: {
      localAuthEnabled: false,
      providers: [{ id: 'p1', displayName: 'Corporate SSO' }],
    },
  };

  it('renders the provider button instead of redirecting', async () => {
    mockApiFetch.mockResolvedValue(singleProvider);
    const Wrapper = createWrapper();
    render(<Login />, { wrapper: Wrapper });

    // The button must be present and clickable — not a "Signing in via SSO"
    // spinner standing in for a redirect already in flight.
    expect(await screen.findByText(/Corporate SSO/i)).toBeInTheDocument();
    expect(screen.queryByText(/Signing in via SSO/i)).not.toBeInTheDocument();
  });

  it('does not navigate to the IdP on its own', async () => {
    mockApiFetch.mockResolvedValue(singleProvider);
    // jsdom does not perform navigation on `window.location.href = ...`, so
    // asserting the URL is unchanged proves nothing. Replace location with a
    // plain object and read back what the component assigned to it.
    const original = window.location;
    const fake = { ...original, href: 'http://localhost/login' } as unknown as Location;
    Object.defineProperty(window, 'location', { value: fake, writable: true, configurable: true });
    try {
      const Wrapper = createWrapper();
      render(<Login />, { wrapper: Wrapper });
      await screen.findByText(/Corporate SSO/i);
      // Well past the old 500ms timer.
      await new Promise((r) => setTimeout(r, 900));
      expect(window.location.href).toBe('http://localhost/login');
    } finally {
      Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true });
    }
  });
});
