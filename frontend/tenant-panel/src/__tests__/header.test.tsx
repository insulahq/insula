import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Header from '../components/layout/Header';

const mockLogout = vi.fn();

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'tenant-1', email: 'test@example.com', fullName: 'Test User', role: 'tenant' },
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
    login: vi.fn(),
    logout: mockLogout,
    initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-password', () => ({
  useChangePassword: vi.fn(() => ({
    mutateAsync: vi.fn().mockResolvedValue({ data: { message: 'Password updated successfully' } }),
    isPending: false,
  })),
}));

vi.mock('../hooks/use-dark-mode', () => ({
  useDarkMode: vi.fn(() => ({ theme: 'system', isDark: false, setTheme: vi.fn(), cycle: vi.fn() })),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('Tenant Header user menu', () => {
  it('renders user menu button', () => {
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByTestId('user-menu-button')).toBeInTheDocument();
  });

  it('opens dropdown on click and shows user name and email', async () => {
    const user = userEvent.setup();
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('user-menu-button'));

    expect(screen.getByTestId('user-menu-dropdown')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-name')).toHaveTextContent('Test User');
    expect(screen.getByTestId('user-menu-email')).toHaveTextContent('test@example.com');
  });

  it('shows Change Password and Sign Out options', async () => {
    const user = userEvent.setup();
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('user-menu-button'));

    expect(screen.getByTestId('change-password-menu-item')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-sign-out')).toBeInTheDocument();
  });

  it('calls logout when Sign Out is clicked', async () => {
    const user = userEvent.setup();
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('user-menu-button'));
    await user.click(screen.getByTestId('user-menu-sign-out'));

    expect(mockLogout).toHaveBeenCalled();
  });

  it('renders no password field until Change Password is clicked', async () => {
    const user = userEvent.setup();
    const { container } = render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    // Password managers latch onto any input[type=password] in the DOM, so the
    // header must not carry one — neither closed nor with the menu open.
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0);

    await user.click(screen.getByTestId('user-menu-button'));

    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(screen.queryByTestId('user-menu-password-form')).not.toBeInTheDocument();
  });

  it('opens the change-password modal and closes the dropdown when Change Password is clicked', async () => {
    const user = userEvent.setup();
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('user-menu-button'));
    await user.click(screen.getByTestId('change-password-menu-item'));

    // Modal is lazy-loaded — resolve the chunk before asserting.
    expect(await screen.findByTestId('change-password-modal')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-password-form')).toBeInTheDocument();
    expect(screen.getByTestId('menu-current-password')).toBeInTheDocument();
    expect(screen.getByTestId('menu-new-password')).toBeInTheDocument();
    expect(screen.getByTestId('menu-confirm-password')).toBeInTheDocument();

    // The dropdown gives way to the modal rather than hosting the form inline.
    expect(screen.queryByTestId('user-menu-dropdown')).not.toBeInTheDocument();
  });

  it('closes the change-password modal on Cancel', async () => {
    const user = userEvent.setup();
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('user-menu-button'));
    await user.click(screen.getByTestId('change-password-menu-item'));
    await screen.findByTestId('change-password-modal');

    await user.click(screen.getByTestId('menu-cancel-password-button'));

    expect(screen.queryByTestId('change-password-modal')).not.toBeInTheDocument();
  });

  it('closes dropdown when clicking user menu button again', async () => {
    const user = userEvent.setup();
    render(<Header onMenuClick={vi.fn()} />, { wrapper: createWrapper() });

    await user.click(screen.getByTestId('user-menu-button'));
    expect(screen.getByTestId('user-menu-dropdown')).toBeInTheDocument();

    await user.click(screen.getByTestId('user-menu-button'));
    expect(screen.queryByTestId('user-menu-dropdown')).not.toBeInTheDocument();
  });
});
