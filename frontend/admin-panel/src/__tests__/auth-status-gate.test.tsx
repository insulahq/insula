import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Login from '../pages/Login';
import { apiFetch, ApiError } from '@/lib/api-client';
import {
  isApiUnreachable,
  authStatusRetryDelayMs,
  AUTH_STATUS_RETRY_MAX_MS,
  AUTH_STATUS_PROBE_TIMEOUT_MS,
} from '@/hooks/use-auth-status';

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
});

describe('isApiUnreachable', () => {
  // These three mean "nothing answered upstream" — the edge or the app
  // itself reporting it cannot serve. They are the whole reason the gate
  // exists, so they must classify as unreachable.
  it.each([502, 503, 504])('treats HTTP %i as unreachable', (status) => {
    expect(isApiUnreachable(new MockApiError(status, 'X', 'x'))).toBe(true);
  });

  // The API ANSWERED. Gating here would be our own gate locking the operator
  // out of a login form that might work perfectly well.
  it.each([400, 401, 403, 404, 409, 429, 500])('treats HTTP %i as answered', (status) => {
    expect(isApiUnreachable(new MockApiError(status, 'X', 'x'))).toBe(false);
  });

  it('treats a raw network error (fetch TypeError) as unreachable', () => {
    expect(isApiUnreachable(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('treats an aborted probe as unreachable', () => {
    // A hung probe is aborted by AUTH_STATUS_PROBE_TIMEOUT_MS. If that landed
    // in the "answered" bucket the gate would fall back to the permissive
    // default and render the dead form we are trying to avoid.
    const abort = new DOMException('The operation was aborted', 'AbortError');
    expect(isApiUnreachable(abort)).toBe(true);
  });
});

describe('authStatusRetryDelayMs', () => {
  it('grows exponentially and caps', () => {
    // random() = 1 → the top of the jitter window, i.e. the nominal delay.
    const at = (n: number) => authStatusRetryDelayMs(n, () => 1);
    expect(at(1)).toBe(1_000);
    expect(at(2)).toBe(2_000);
    expect(at(3)).toBe(4_000);
    expect(at(4)).toBe(8_000);
    expect(at(5)).toBe(AUTH_STATUS_RETRY_MAX_MS);
    expect(at(50)).toBe(AUTH_STATUS_RETRY_MAX_MS);
  });

  it('jitters within the upper half of the window, never to zero', () => {
    // A zero-or-near-zero delay would turn the backoff into a hot loop
    // against an API that is already struggling.
    expect(authStatusRetryDelayMs(1, () => 0)).toBe(500);
    expect(authStatusRetryDelayMs(9, () => 0)).toBe(AUTH_STATUS_RETRY_MAX_MS / 2);
  });
});

describe('Login API-readiness gate', () => {
  it('shows the waiting panel instead of a dead login form when the API is down', async () => {
    mockApiFetch.mockRejectedValue(new MockApiError(503, 'UNAVAILABLE', 'no upstream'));
    render(<Login />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('api-unavailable')).toBeInTheDocument();
    });
    // The whole point: no credentials field to type into.
    expect(screen.queryByTestId('login-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('password-input')).not.toBeInTheDocument();
    expect(screen.getByText('Waiting for the platform API…')).toBeInTheDocument();
    expect(screen.getByTestId('api-unavailable-retry')).toBeInTheDocument();
  });

  it('renders the login form once the API answers', async () => {
    mockApiFetch.mockResolvedValue({ data: { localAuthEnabled: true, providers: [] } });
    render(<Login />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('login-form')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('api-unavailable')).not.toBeInTheDocument();
  });

  it('falls back permissively when the API answers with an error we cannot read', async () => {
    // A misconfigured edge gate must not become a lockout.
    mockApiFetch.mockRejectedValue(new MockApiError(404, 'NOT_FOUND', 'nope'));
    render(<Login />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('login-form')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('api-unavailable')).not.toBeInTheDocument();
  });

  it('lets break-glass through the gate even while the API is unreachable', async () => {
    // An emergency admin login is exactly when you do NOT want a spinner
    // deciding on the operator's behalf.
    mockApiFetch.mockRejectedValue(new MockApiError(503, 'UNAVAILABLE', 'no upstream'));
    render(<Login />, { wrapper: createWrapper(['/login?emergency=true']) });

    await waitFor(() => {
      expect(screen.getByTestId('break-glass-form')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('api-unavailable')).not.toBeInTheDocument();
  });

  it('renders SSO buttons from a successful probe (the OIDC path the old catch broke)', async () => {
    mockApiFetch.mockResolvedValue({
      data: {
        localAuthEnabled: true,
        providers: [{ id: 'dex', displayName: 'Corp SSO' }],
      },
    });
    render(<Login />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('sso-button-dex')).toBeInTheDocument();
    });
  });

  it('probes exactly once on the healthy path — the gate adds no extra load', async () => {
    mockApiFetch.mockResolvedValue({ data: { localAuthEnabled: true, providers: [] } });
    render(<Login />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('login-form')).toBeInTheDocument();
    });
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/auth/oidc/status?panel=admin',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('bounds a hung probe so it cannot sit in loading showing a dead form', async () => {
    // The gate's own failure mode: a probe that never settles leaves the hook
    // in `loading`, which renders the login form. Assert the request carries
    // an abort signal and that the budget is finite and short.
    expect(AUTH_STATUS_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(AUTH_STATUS_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(15_000);

    let capturedSignal: AbortSignal | undefined;
    mockApiFetch.mockImplementation((_path: string, opts?: RequestInit) => {
      capturedSignal = opts?.signal as AbortSignal | undefined;
      return new Promise(() => { /* never settles */ });
    });

    render(<Login />, { wrapper: createWrapper() });

    await waitFor(() => { expect(capturedSignal).toBeDefined(); });
    expect(capturedSignal!.aborted).toBe(false);
    await waitFor(
      () => { expect(capturedSignal!.aborted).toBe(true); },
      { timeout: AUTH_STATUS_PROBE_TIMEOUT_MS + 4_000 },
    );
    // Real timers: this test deliberately waits out the actual abort budget
    // rather than faking it, so the per-test timeout has to clear it.
  }, AUTH_STATUS_PROBE_TIMEOUT_MS + 12_000);
});
