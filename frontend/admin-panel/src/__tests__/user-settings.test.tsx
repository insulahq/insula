import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UserSettings from '../pages/UserSettings';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message); this.name = 'ApiError';
    }
  },
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'u1', email: 'admin@test.com', fullName: 'Admin User', role: 'admin' },
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    initialize: vi.fn(),
  })),
}));

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  };
}

beforeEach(() => vi.clearAllMocks());

describe('UserSettings page', () => {
  it('renders heading', () => {
    render(<UserSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('user-settings-heading')).toHaveTextContent('User Settings');
  });

  it('renders profile section with user data', () => {
    render(<UserSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('profile-section')).toBeInTheDocument();
    expect(screen.getByTestId('profile-full-name')).toHaveValue('Admin User');
    expect(screen.getByTestId('profile-email')).toHaveValue('admin@test.com');
  });

  it('renders the password section', () => {
    render(<UserSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('password-section')).toBeInTheDocument();
  });

  // The password inputs deliberately live in a lazy-loaded modal, NOT inline on
  // this page: routes are not code-split, so anything rendered here ships in the
  // entry chunk that every page view downloads, and password managers latch onto
  // the fields on every load. Measured on the admin panel: moving this form out
  // took the entry chunk from 21 password inputs to 18.
  it('does NOT ship password inputs on the page itself', () => {
    const { container } = render(<UserSettings />, { wrapper: createWrapper() });
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(screen.queryByTestId('settings-current-password')).not.toBeInTheDocument();
  });

  it('opens the change-password modal on demand', async () => {
    const user = userEvent.setup();
    render(<UserSettings />, { wrapper: createWrapper() });
    await user.click(screen.getByTestId('settings-open-password-modal'));
    await waitFor(() => {
      expect(screen.getByTestId('change-password-modal')).toBeInTheDocument();
    });
  });

  it('has profile save button', () => {
    render(<UserSettings />, { wrapper: createWrapper() });
    expect(screen.getByTestId('profile-save-button')).toBeInTheDocument();
  });

});
