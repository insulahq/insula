import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Login from '../pages/Login';
import { apiFetch, ApiError } from '@/lib/api-client';
import { isApiUnreachable, authStatusRetryDelayMs, AUTH_STATUS_RETRY_MAX_MS } from '@/hooks/use-auth-status';

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
const MockApiError = vi.mocked(ApiError);

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/login']}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('tenant-panel API-readiness classification', () => {
  it.each([502, 503, 504])('treats HTTP %i as unreachable', (status) => {
    expect(isApiUnreachable(new MockApiError(status, 'X', 'x'))).toBe(true);
  });

  it.each([401, 403, 404, 500])('treats HTTP %i as answered', (status) => {
    expect(isApiUnreachable(new MockApiError(status, 'X', 'x'))).toBe(false);
  });

  it('caps and jitters the retry delay', () => {
    expect(authStatusRetryDelayMs(1, () => 1)).toBe(1_000);
    expect(authStatusRetryDelayMs(9, () => 1)).toBe(AUTH_STATUS_RETRY_MAX_MS);
    expect(authStatusRetryDelayMs(1, () => 0)).toBe(500);
  });
});

describe('tenant-panel Login gate', () => {
  it('shows the waiting panel instead of a dead login form when the API is down', async () => {
    mockApiFetch.mockRejectedValue(new MockApiError(503, 'UNAVAILABLE', 'no upstream'));
    render(<Login />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('api-unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('password-input')).not.toBeInTheDocument();
  });

  it('renders the login form once the API answers', async () => {
    mockApiFetch.mockResolvedValue({ data: { localAuthEnabled: true, providers: [] } });
    render(<Login />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('password-input')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('api-unavailable')).not.toBeInTheDocument();
  });

  it('the GATE still probes exactly once — it adds no request of its own', async () => {
    mockApiFetch.mockResolvedValue({ data: { localAuthEnabled: true, providers: [] } });
    render(<Login />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('password-input')).toBeInTheDocument();
    });

    const gateCalls = mockApiFetch.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.startsWith('/api/v1/auth/oidc/status'),
    );
    expect(gateCalls).toHaveLength(1);
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/auth/oidc/status?panel=tenant',
      expect.objectContaining({ signal: expect.anything() }),
    );

    // Plus ONE public branding GET: the login screen renders the operator's
    // platform name and sits outside <Layout>. Asserted by URL rather than as
    // a bare total, so an accidental third request still fails here.
    const brandingCalls = mockApiFetch.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.startsWith('/api/v1/system-info'),
    );
    expect(brandingCalls).toHaveLength(1);
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('treats an aborted probe as unreachable', () => {
    // A hung probe is aborted by AUTH_STATUS_PROBE_TIMEOUT_MS; if that were
    // classified as "answered" the gate would fall back to the permissive
    // default and render the dead form this change exists to prevent.
    expect(isApiUnreachable(new DOMException('aborted', 'AbortError'))).toBe(true);
  });
});
