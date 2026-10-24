/**
 * A mailbox holds at most 10 login passwords; the mail server keeps one more
 * app password free for an "Open webmail" session, which does not count.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LoginPassword } from '@insula/api-contracts';

const loginRow = (i: number): LoginPassword => ({ id: `l${i}`, label: `Device ${i}`, kind: 'login', createdAt: '2026-09-01T00:00:00Z', expiresAt: null, allowedIps: [] });
const sessionRow = (i: number): LoginPassword => ({ id: `s${i}`, label: 'Webmail session', kind: 'webmail_session', createdAt: '2026-10-24T08:00:00Z', expiresAt: '2026-10-24T16:00:00Z', allowedIps: [] });

vi.mock('@/hooks/use-email', () => ({
  useAdminLoginPasswords: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useAdminCreateLoginPassword: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useAdminRevokeLoginPassword: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
}));

const { AdminMailboxLoginPasswordsModal } = await import('../components/email/AdminMailboxLoginPasswords');
const { useAdminLoginPasswords } = await import('@/hooks/use-email');
const withRows = (list: LoginPassword[]) =>
  vi.mocked(useAdminLoginPasswords).mockReturnValue({ data: { data: list }, isLoading: false } as never);

describe('AdminMailboxLoginPasswordsModal — limit', () => {
  it('counts login passwords but not webmail sessions', () => {
    withRows([...Array.from({ length: 9 }, (_, i) => loginRow(i)), sessionRow(1), sessionRow(2)]);
    render(<AdminMailboxLoginPasswordsModal mailboxId="m1" fullAddress="info@example.test" onClose={() => {}} />);
    expect(screen.getByTestId('admin-login-password-count')).toHaveTextContent('9 of 10 login passwords');
    expect(screen.getByTestId('admin-new-login-password')).toBeEnabled();
  });

  it('stops at ten and says what to do', () => {
    withRows([...Array.from({ length: 10 }, (_, i) => loginRow(i)), sessionRow(1)]);
    render(<AdminMailboxLoginPasswordsModal mailboxId="m1" fullAddress="info@example.test" onClose={() => {}} />);
    expect(screen.getByTestId('admin-login-password-count')).toHaveTextContent('10 of 10 login passwords — the most a mailbox can have. Revoke one to create another.');
    expect(screen.getByTestId('admin-new-login-password')).toBeDisabled();
  });
});
