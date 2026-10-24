/**
 * A webmail session in the login-password list reads as one. Bulwark (1.11.1+)
 * signs "Open webmail" in with an app password it creates on the mailbox;
 * listed raw it was "Support session 0b8f…", which a tenant reads as someone
 * from support having opened their mail.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { LoginPassword } from '@insula/api-contracts';

const rows: LoginPassword[] = [
  { id: 'p1', label: 'iPhone', kind: 'login', createdAt: '2026-09-01T00:00:00Z', expiresAt: null, allowedIps: [] },
  { id: 'w1', label: 'Webmail session', kind: 'webmail_session', createdAt: '2026-10-04T08:00:00Z', expiresAt: '2026-10-04T16:00:00Z', allowedIps: [] },
];
const loginRow = (i: number): LoginPassword => ({ id: `l${i}`, label: `Device ${i}`, kind: 'login', createdAt: '2026-09-01T00:00:00Z', expiresAt: null, allowedIps: [] });
const sessionRow = (i: number): LoginPassword => ({ id: `s${i}`, label: 'Webmail session', kind: 'webmail_session', createdAt: '2026-10-24T08:00:00Z', expiresAt: '2026-10-24T16:00:00Z', allowedIps: [] });

const createMutate = vi.fn(async () => ({ data: { id: 'n', label: 'Laptop', secret: 's', expiresAt: null, allowedIps: [] } }));

vi.mock('../hooks/use-email', () => ({
  useLoginPasswords: vi.fn(() => ({ data: { data: rows }, isLoading: false })),
  useCreateLoginPassword: vi.fn(() => ({ mutateAsync: createMutate, isPending: false, error: null })),
  useRevokeLoginPassword: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
}));

const { MailboxLoginPasswordsModal } = await import('../components/MailboxLoginPasswords');
const { useLoginPasswords } = await import('../hooks/use-email');

describe('MailboxLoginPasswordsModal — webmail sessions', () => {
  it('explains a webmail session and offers to sign it out', () => {
    render(<MailboxLoginPasswordsModal tenantId="t1" mailboxId="m1" fullAddress="info@example.test" onClose={() => {}} />);

    const session = screen.getByTestId('login-password-row-w1');
    expect(session).toHaveTextContent('Webmail session');
    expect(session).toHaveTextContent('Opened with “Open webmail” — ends by itself');
    expect(session).toHaveTextContent(new Date('2026-10-04T16:00:00Z').toLocaleString());

    fireEvent.click(screen.getByTestId('login-password-revoke-w1'));
    expect(screen.getByTestId('login-password-revoke-confirm-w1')).toHaveTextContent('Sign out');
  });

  it('leaves an ordinary login password as it was', () => {
    render(<MailboxLoginPasswordsModal tenantId="t1" mailboxId="m1" fullAddress="info@example.test" onClose={() => {}} />);

    const login = screen.getByTestId('login-password-row-p1');
    expect(login).not.toHaveTextContent('ends by itself');
    expect(screen.getByTestId('login-password-revoke-p1')).toHaveTextContent('Revoke');
  });

  // An expired login password is deleted and the server refuses an expiry that
  // is not in the future, so the first date offered is tomorrow — the viewer's
  // tomorrow, since the date means the start of that day in their zone.
  it('offers expiry dates from tomorrow and sends the start of the picked day in the viewer\'s zone', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 24, 23, 30), toFake: ['Date'] });
    try {
      render(<MailboxLoginPasswordsModal tenantId="t1" mailboxId="m1" fullAddress="info@example.test" onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('new-login-password'));

      const expires = screen.getByTestId('login-password-expires');
      expect(expires).toHaveAttribute('min', '2026-10-25');
      expect(screen.getByTestId('new-login-password-form')).toHaveTextContent('deleted when it expires');

      fireEvent.change(screen.getByTestId('login-password-label'), { target: { value: 'Laptop' } });
      fireEvent.change(expires, { target: { value: '2026-10-30' } });
      fireEvent.submit(screen.getByTestId('new-login-password-form'));
      expect(createMutate).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'Laptop', expiresAt: new Date(2026, 9, 30).toISOString() }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// A mailbox holds at most 10 login passwords; the mail server keeps one more
// app password free for an "Open webmail" session, which does not count.
describe('MailboxLoginPasswordsModal — limit', () => {
  const withRows = (list: LoginPassword[]) =>
    vi.mocked(useLoginPasswords).mockReturnValue({ data: { data: list }, isLoading: false } as never);

  it('counts login passwords but not webmail sessions', () => {
    withRows([...Array.from({ length: 9 }, (_, i) => loginRow(i)), sessionRow(1), sessionRow(2)]);
    render(<MailboxLoginPasswordsModal tenantId="t1" mailboxId="m1" fullAddress="info@example.test" onClose={() => {}} />);

    expect(screen.getByTestId('login-password-count')).toHaveTextContent('9 of 10 login passwords');
    expect(screen.getByTestId('new-login-password')).toBeEnabled();
  });

  it('stops at ten and says what to do', () => {
    withRows([...Array.from({ length: 10 }, (_, i) => loginRow(i)), sessionRow(1)]);
    render(<MailboxLoginPasswordsModal tenantId="t1" mailboxId="m1" fullAddress="info@example.test" onClose={() => {}} />);

    expect(screen.getByTestId('login-password-count')).toHaveTextContent('10 of 10 login passwords — the most a mailbox can have. Revoke one to create another.');
    expect(screen.getByTestId('new-login-password')).toBeDisabled();
  });
});
