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

describe('AdminMailboxLoginPasswordsModal — column sorting', () => {
  const row = (id: string, label: string, createdAt: string) => ({
    id, label, kind: 'login' as const, createdAt, expiresAt: null, allowedIps: [],
  });

  it('opens by label ("(no label)" last), then sorts by created both ways', async () => {
    const { useAdminLoginPasswords } = await import('@/hooks/use-email');
    vi.mocked(useAdminLoginPasswords).mockReturnValue({
      data: { data: [
        row('p1', 'Phone', '2026-10-01T10:00:00.000Z'),
        row('p2', '', '2026-10-03T10:00:00.000Z'),
        row('p3', 'Laptop', '2026-10-02T10:00:00.000Z'),
      ] },
      isLoading: false,
    } as unknown as ReturnType<typeof useAdminLoginPasswords>);
    render(<AdminMailboxLoginPasswordsModal mailboxId="m1" fullAddress="info@example.test" onClose={() => {}} />);
    const table = screen.getByTestId('admin-login-passwords-table');
    const labels = () => Array.from(table.querySelectorAll('tbody > tr')).map((tr) => tr.querySelector('td')?.textContent);
    expect(labels()).toEqual(['Laptop', 'Phone', '(no label)']);

    fireEvent.click(screen.getByTestId('sort-createdAt'));
    expect(labels()).toEqual(['Phone', 'Laptop', '(no label)']);
    fireEvent.click(screen.getByTestId('sort-createdAt'));
    expect(labels()).toEqual(['(no label)', 'Laptop', 'Phone']);
  });
});
