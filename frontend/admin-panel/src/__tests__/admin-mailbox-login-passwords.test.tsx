/**
 * An expired login password is deleted, and the server refuses an expiry that
 * is not in the future. The picked date is a day in the viewer's zone: sent as
 * UTC midnight, it read as the day before west of UTC.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const createMutate = vi.fn(async () => ({ data: { id: 'n', label: 'Laptop', secret: 's', expiresAt: null, allowedIps: [] } }));

vi.mock('@/hooks/use-email', () => ({
  useAdminLoginPasswords: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useAdminCreateLoginPassword: vi.fn(() => ({ mutateAsync: createMutate, isPending: false, error: null })),
  useAdminRevokeLoginPassword: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
}));

const { AdminMailboxLoginPasswordsModal } = await import('../components/email/AdminMailboxLoginPasswords');

describe('AdminMailboxLoginPasswordsModal — expiry date', () => {
  it('offers dates from tomorrow and sends the start of the picked day in the viewer\'s zone', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 24, 23, 30), toFake: ['Date'] });
    try {
      render(<AdminMailboxLoginPasswordsModal mailboxId="m1" fullAddress="info@example.test" onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('admin-new-login-password'));

      const expires = screen.getByTestId('admin-login-password-expires');
      expect(expires).toHaveAttribute('min', '2026-10-25');
      expect(screen.getByText(/deleted when it expires/)).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('admin-login-password-label'), { target: { value: 'Laptop' } });
      fireEvent.change(expires, { target: { value: '2026-10-30' } });
      fireEvent.click(screen.getByTestId('admin-login-password-submit'));
      expect(createMutate).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'Laptop', expiresAt: new Date(2026, 9, 30).toISOString() }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
