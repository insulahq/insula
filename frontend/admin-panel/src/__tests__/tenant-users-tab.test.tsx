import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TenantUsersTab from '../components/TenantUsersTab';

const createMutate = vi.fn();
const updateMutate = vi.fn();
const resetMutate = vi.fn();
const resetResetFn = vi.fn();
const deleteMutate = vi.fn();
// The reset mutation now RESOLVES WITH the regenerated password, so
// the modal renders from `data` rather than a bare `isSuccess` flag.
let resetData: { data: { password: string } } | undefined;

vi.mock('../hooks/use-sub-users', () => ({
  useAdminSubUsers: vi.fn(() => ({
    data: { data: [] },
    isLoading: false,
    isError: false,
  })),
  useAdminCreateSubUser: vi.fn(() => ({
    mutateAsync: createMutate,
    isPending: false,
    error: null,
  })),
  useAdminUpdateSubUser: vi.fn(() => ({
    mutateAsync: updateMutate,
    isPending: false,
    error: null,
  })),
  useAdminResetSubUserPassword: vi.fn(() => ({
    mutateAsync: resetMutate,
    reset: resetResetFn,
    isPending: false,
    data: resetData,
    error: null,
  })),
  useAdminDeleteSubUser: vi.fn(() => ({
    mutateAsync: deleteMutate,
    isPending: false,
  })),
}));

import { useAdminSubUsers } from '../hooks/use-sub-users';
const mockedUseAdminSubUsers = vi.mocked(useAdminSubUsers);

/**
 * Shape of a successful create response. The tab reads
 * `data.generatedPassword` off it, so a stub missing that field would
 * render `undefined` as the credential instead of failing loudly.
 */
function createdUserResponse(
  overrides: { email?: string; generatedPassword?: string } = {},
) {
  return {
    data: {
      id: 'u-new',
      email: overrides.email ?? 'charlie@c1.com',
      fullName: 'Charlie',
      roleName: 'tenant_user',
      status: 'active',
      createdAt: '2026-01-02T00:00:00Z',
      generatedPassword: overrides.generatedPassword ?? 'Generated!Password01',
    },
  };
}

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('TenantUsersTab', () => {
  beforeEach(() => {
    createMutate.mockReset();
    updateMutate.mockReset();
    resetMutate.mockReset();
    resetResetFn.mockReset();
    deleteMutate.mockReset();
    resetData = undefined;
    mockedUseAdminSubUsers.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useAdminSubUsers>);
  });

  it('renders an empty state when the tenant has no sub-users', () => {
    render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tenant-users-empty')).toBeInTheDocument();
    expect(screen.getByText(/No team members yet/)).toBeInTheDocument();
  });

  it('renders a loading state', () => {
    mockedUseAdminSubUsers.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useAdminSubUsers>);
    render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tenant-users-loading')).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockedUseAdminSubUsers.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useAdminSubUsers>);
    render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tenant-users-error')).toBeInTheDocument();
  });

  describe('with users', () => {
    beforeEach(() => {
      mockedUseAdminSubUsers.mockReturnValue({
        data: {
          data: [
            {
              id: 'u1',
              fullName: 'Alice',
              email: 'alice@c1.com',
              roleName: 'tenant_admin',
              status: 'active',
              createdAt: '2026-01-01T00:00:00Z',
              lastLoginAt: null,
            },
            {
              id: 'u2',
              fullName: 'Bob',
              email: 'bob@c1.com',
              roleName: 'tenant_user',
              status: 'disabled',
              createdAt: '2026-01-02T00:00:00Z',
              lastLoginAt: null,
            },
          ],
        },
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useAdminSubUsers>);
    });

    it('renders the user table with both rows', () => {
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      expect(screen.getByTestId('tenant-users-table')).toBeInTheDocument();
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    it('renders all row action buttons', () => {
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      expect(screen.getByTestId('tenant-users-edit-u1')).toBeInTheDocument();
      expect(screen.getByTestId('tenant-users-reset-u1')).toBeInTheDocument();
      expect(screen.getByTestId('tenant-users-toggle-u1')).toBeInTheDocument();
      expect(screen.getByTestId('tenant-users-delete-u1')).toBeInTheDocument();
    });

    it('opens the Add User form and calls the create mutation', async () => {
      createMutate.mockResolvedValueOnce(createdUserResponse());
      const user = userEvent.setup();
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('tenant-users-add-button'));
      expect(screen.getByTestId('tenant-users-create-form')).toBeInTheDocument();
      await user.type(screen.getByTestId('tenant-users-name-input'), 'Charlie');
      await user.type(screen.getByTestId('tenant-users-email-input'), 'charlie@c1.com');
      await user.click(screen.getByTestId('tenant-users-submit'));
      expect(createMutate).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'charlie@c1.com', role_name: 'tenant_user' }),
      );
    });

    it('offers no password field and never sends one', async () => {
      createMutate.mockResolvedValueOnce(createdUserResponse());
      const user = userEvent.setup();
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('tenant-users-add-button'));
      expect(screen.queryByTestId('tenant-users-password-input')).not.toBeInTheDocument();
      expect(
        screen.getByTestId('tenant-users-create-form').querySelectorAll('input[type="password"]'),
      ).toHaveLength(0);

      await user.type(screen.getByTestId('tenant-users-name-input'), 'Charlie');
      await user.type(screen.getByTestId('tenant-users-email-input'), 'charlie@c1.com');
      await user.click(screen.getByTestId('tenant-users-submit'));
      expect(createMutate).toHaveBeenCalledWith(
        expect.not.objectContaining({ password: expect.anything() }),
      );
    });

    it('shows the generated password once after creating a user', async () => {
      createMutate.mockResolvedValueOnce(
        createdUserResponse({ email: 'charlie@c1.com', generatedPassword: 'Sup3rSecret!Value00' }),
      );
      const user = userEvent.setup();
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('tenant-users-add-button'));
      await user.type(screen.getByTestId('tenant-users-name-input'), 'Charlie');
      await user.type(screen.getByTestId('tenant-users-email-input'), 'charlie@c1.com');
      await user.click(screen.getByTestId('tenant-users-submit'));

      expect(await screen.findByTestId('tenant-users-new-credentials')).toBeInTheDocument();
      expect(screen.getByTestId('tenant-users-new-credentials-value'))
        .toHaveTextContent('Sup3rSecret!Value00');

      await user.click(screen.getByTestId('tenant-users-dismiss-credentials'));
      expect(screen.queryByTestId('tenant-users-new-credentials')).not.toBeInTheDocument();
    });

    it('requires confirmation before disabling an active user', async () => {
      updateMutate.mockResolvedValueOnce({ data: { id: 'u1' } });
      const user = userEvent.setup();
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('tenant-users-toggle-u1'));
      expect(updateMutate).not.toHaveBeenCalled();
      await user.click(screen.getByTestId('tenant-users-disable-confirm-u1'));
      expect(updateMutate).toHaveBeenCalledWith({
        userId: 'u1',
        patch: { status: 'disabled' },
      });
    });

    it('re-enables a disabled user without confirmation', async () => {
      updateMutate.mockResolvedValueOnce({ data: { id: 'u2' } });
      const user = userEvent.setup();
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('tenant-users-toggle-u2'));
      expect(updateMutate).toHaveBeenCalledWith({
        userId: 'u2',
        patch: { status: 'active' },
      });
    });

    it('opens the edit modal and sends only changed fields', async () => {
      updateMutate.mockResolvedValueOnce({ data: { id: 'u1' } });
      const user = userEvent.setup();
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('tenant-users-edit-u1'));
      expect(screen.getByTestId('tenant-users-edit-modal')).toBeInTheDocument();
      const nameInput = screen.getByTestId('tenant-users-edit-name-input');
      await user.clear(nameInput);
      await user.type(nameInput, 'Alice Renamed');
      await user.click(screen.getByTestId('tenant-users-edit-save'));
      expect(updateMutate).toHaveBeenCalledWith({
        userId: 'u1',
        patch: { full_name: 'Alice Renamed' },
      });
    });

    it('opens a confirm-only reset modal with no password fields', async () => {
      const user = userEvent.setup();
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('tenant-users-reset-u1'));
      const modal = screen.getByTestId('tenant-users-reset-modal');
      expect(modal).toBeInTheDocument();
      // A reset REGENERATES — there is nothing to type.
      expect(screen.queryByTestId('tenant-users-reset-new-input')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tenant-users-reset-confirm-input')).not.toBeInTheDocument();
      expect(modal.querySelectorAll('input')).toHaveLength(0);
    });

    it('calls the reset-password mutation with only the user id', async () => {
      resetMutate.mockResolvedValueOnce({ data: { password: 'x' } });
      const user = userEvent.setup();
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('tenant-users-reset-u1'));
      await user.click(screen.getByTestId('tenant-users-reset-save'));
      expect(resetMutate).toHaveBeenCalledWith({ userId: 'u1' });
    });

    it('displays the regenerated password once the mutation resolves', async () => {
      resetData = { data: { password: 'Regenerated!Pw02' } };
      const user = userEvent.setup();
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('tenant-users-reset-u1'));
      // Modal must be open AND showing the success branch
      expect(screen.getByTestId('tenant-users-reset-modal')).toBeInTheDocument();
      expect(screen.getByTestId('tenant-users-reset-success')).toBeInTheDocument();
      expect(screen.getByTestId('tenant-users-reset-credentials-value'))
        .toHaveTextContent('Regenerated!Pw02');
      // The success branch has a Done button, not Save
      expect(screen.getByTestId('tenant-users-reset-done')).toBeInTheDocument();
      expect(screen.queryByTestId('tenant-users-reset-save')).not.toBeInTheDocument();
      // Clicking Done should reset the mutation state and close the modal
      await user.click(screen.getByTestId('tenant-users-reset-done'));
      expect(resetResetFn).toHaveBeenCalled();
    });

    it('requires confirmation before deleting', async () => {
      deleteMutate.mockResolvedValueOnce(undefined);
      const user = userEvent.setup();
      render(<TenantUsersTab tenantId="c1" />, { wrapper: createWrapper() });
      await user.click(screen.getByTestId('tenant-users-delete-u1'));
      expect(deleteMutate).not.toHaveBeenCalled();
      await user.click(screen.getByTestId('tenant-users-delete-confirm-u1'));
      expect(deleteMutate).toHaveBeenCalledWith('u1');
    });
  });
});
