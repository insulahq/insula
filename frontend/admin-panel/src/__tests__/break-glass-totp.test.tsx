import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Login from '../pages/Login';
import { apiFetch, ApiError } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

function renderEmergencyLogin() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/login?emergency=true']}><Login /></MemoryRouter>
    </QueryClientProvider>,
  );
}

function breakGlassBodies(): Array<Record<string, unknown>> {
  return mockApiFetch.mock.calls
    .filter(([url]) => url === '/api/v1/auth/break-glass')
    .map(([, init]) => JSON.parse((init as { body: string }).body));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('emergency (break-glass) sign-in with an authenticator app', () => {
  it('shows why it was refused — the code is needed — instead of failing silently', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/auth/break-glass') {
        throw new ApiError(401, 'TOTP_REQUIRED', 'This account uses an authenticator app. Enter its code (or a backup code).');
      }
      return { data: { localAuthEnabled: true, providers: [] } };
    });
    renderEmergencyLogin();
    await waitFor(() => expect(screen.getByTestId('break-glass-form')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('email-input'), { target: { value: 'ada@example.test' } });
    fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByTestId('break-glass-secret-input'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByTestId('break-glass-button'));
    await waitFor(() => expect(screen.getByTestId('break-glass-error')).toHaveTextContent('authenticator app'));
    expect(breakGlassBodies()[0]).not.toHaveProperty('code');
  });

  it('sends six digits as the live code and anything else as a backup code', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/v1/auth/break-glass') throw new ApiError(401, 'TOTP_CODE_INVALID', 'no');
      return { data: { localAuthEnabled: true, providers: [] } };
    });
    renderEmergencyLogin();
    await waitFor(() => expect(screen.getByTestId('break-glass-form')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('email-input'), { target: { value: 'ada@example.test' } });
    fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByTestId('break-glass-secret-input'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByTestId('break-glass-code-input'), { target: { value: '123 456' } });
    fireEvent.click(screen.getByTestId('break-glass-button'));
    await waitFor(() => expect(breakGlassBodies()).toHaveLength(1));
    fireEvent.change(screen.getByTestId('break-glass-code-input'), { target: { value: 'abcde-fghij' } });
    fireEvent.click(screen.getByTestId('break-glass-button'));
    await waitFor(() => expect(breakGlassBodies()).toHaveLength(2));
    expect(breakGlassBodies()[0]).toMatchObject({ code: '123 456' });
    expect(breakGlassBodies()[1]).toMatchObject({ backup_code: 'abcde-fghij' });
    expect(breakGlassBodies()[1]).not.toHaveProperty('code');
  });
});

describe('the code step on the login page', () => {
  it('shows a wrong-code message once, inside the step — not again as a page banner', async () => {
    mockApiFetch.mockResolvedValue({ data: { localAuthEnabled: true, providers: [] } });
    useAuth.setState({
      error: 'That code is not right.',
      totpChallenge: { preAuthToken: 'p', expiresIn: 300, user: { id: 'u1', email: 'ada@example.test', fullName: 'A', role: 'admin' } },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/login']}><Login /></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('totp-step')).toBeInTheDocument());
    expect(screen.getAllByText('That code is not right.')).toHaveLength(1);
    expect(screen.queryByTestId('login-error')).not.toBeInTheDocument();
    useAuth.setState({ error: null, totpChallenge: null });
  });
});
