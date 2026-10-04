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

vi.mock('../hooks/use-email', () => ({
  useLoginPasswords: vi.fn(() => ({ data: { data: rows }, isLoading: false })),
  useCreateLoginPassword: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
  useRevokeLoginPassword: vi.fn(() => ({ mutate: vi.fn(), isPending: false, error: null })),
}));

const { MailboxLoginPasswordsModal } = await import('../components/MailboxLoginPasswords');

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
});
