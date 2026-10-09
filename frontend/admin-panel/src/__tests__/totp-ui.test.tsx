import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', async (orig) => ({ ...(await orig<typeof import('@/lib/api-client')>()), apiFetch: api.apiFetch }));

const totp = vi.hoisted(() => ({
  status: { data: undefined as unknown, isLoading: false, error: null as unknown },
  setup: { mutate: vi.fn(), reset: vi.fn(), data: undefined as unknown, isPending: false, error: null as unknown },
  enable: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as unknown },
  disable: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as unknown },
  regenerate: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as unknown },
}));
vi.mock('@/hooks/use-totp', () => ({
  useTotpStatus: () => totp.status,
  useTotpSetup: () => totp.setup,
  useTotpEnable: () => totp.enable,
  useTotpDisable: () => totp.disable,
  useTotpRegenerateBackupCodes: () => totp.regenerate,
}));
const resetMutation = vi.hoisted(() => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as unknown }));
vi.mock('@/hooks/use-admin-users', () => ({ useResetUserTotp: () => resetMutation }));

const { ApiError } = await import('@/lib/api-client');
const { useAuth } = await import('@/hooks/use-auth');
const { default: TotpStep } = await import('../components/auth/TotpStep');
const { default: TotpSection } = await import('../components/settings/TotpSection');
const { default: TotpResetCell } = await import('../components/users/TotpResetCell');

const user = { id: 'u1', email: 'ada@example.test', fullName: 'Ada', role: 'admin' };
const challengeResponse = { data: { requires_totp: true, pre_auth_token: 'pre-1', expires_in: 300, user } };

beforeEach(() => {
  api.apiFetch.mockReset();
  localStorage.clear();
  useAuth.setState({ token: null, user: null, isAuthenticated: false, isLoading: false, error: null, totpChallenge: null });
});

describe('password sign-in with an authenticator app', () => {
  it('stops after the password: a challenge, no session stored', async () => {
    api.apiFetch.mockResolvedValueOnce(challengeResponse);
    await useAuth.getState().login('ada@example.test', 'pw');
    expect(useAuth.getState().totpChallenge?.preAuthToken).toBe('pre-1');
    expect(useAuth.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('the code finishes it: step token + code to the verify step, then the session is stored', async () => {
    api.apiFetch.mockResolvedValueOnce(challengeResponse);
    await useAuth.getState().login('ada@example.test', 'pw');
    api.apiFetch.mockResolvedValueOnce({ data: { token: 't', refreshToken: 'r', user } });
    await useAuth.getState().verifyTotp({ code: '123456' });
    const [url, init] = api.apiFetch.mock.calls[1] as [string, { body: string }];
    expect(url).toBe('/api/v1/auth/totp/login/verify');
    expect(JSON.parse(init.body)).toEqual({ pre_auth_token: 'pre-1', panel: 'admin', code: '123456' });
    expect(useAuth.getState()).toMatchObject({ isAuthenticated: true, totpChallenge: null });
    expect(localStorage.getItem('auth_token')).toBe('t');
    expect(localStorage.getItem('auth_refresh_token')).toBe('r');
  });

  it('a wrong code keeps the step; an expired step goes back to the password', async () => {
    api.apiFetch.mockResolvedValueOnce(challengeResponse);
    await useAuth.getState().login('ada@example.test', 'pw');
    api.apiFetch.mockRejectedValueOnce(new ApiError(401, 'TOTP_CODE_INVALID', 'That code is not right.'));
    await expect(useAuth.getState().verifyTotp({ code: '000000' })).rejects.toBeInstanceOf(ApiError);
    expect(useAuth.getState().totpChallenge).not.toBeNull();
    expect(useAuth.getState().error).toBe('That code is not right.');
    api.apiFetch.mockRejectedValueOnce(new ApiError(401, 'PRE_AUTH_TOKEN_INVALID', 'The sign-in step expired.'));
    await expect(useAuth.getState().verifyTotp({ code: '111111' })).rejects.toBeInstanceOf(ApiError);
    expect(useAuth.getState().totpChallenge).toBeNull();
  });

  it('the code step sends a backup code when the user switches to one, and cancels back', async () => {
    api.apiFetch.mockResolvedValueOnce(challengeResponse);
    await useAuth.getState().login('ada@example.test', 'pw');
    api.apiFetch.mockResolvedValueOnce({ data: { token: 't', refreshToken: 'r', user } });
    const onDone = vi.fn();
    const onCancel = vi.fn();
    render(<TotpStep email="ada@example.test" onDone={onDone} onCancel={onCancel} />);
    expect(screen.getByTestId('totp-step')).toHaveTextContent('ada@example.test');
    fireEvent.click(screen.getByTestId('totp-toggle-backup'));
    fireEvent.change(screen.getByTestId('totp-code-input'), { target: { value: 'abcde-fghij' } });
    fireEvent.click(screen.getByTestId('totp-submit'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(JSON.parse((api.apiFetch.mock.calls[1] as [string, { body: string }])[1].body)).toMatchObject({ backup_code: 'abcde-fghij' });
    fireEvent.click(screen.getByTestId('totp-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('User Settings → Authenticator app', () => {
  beforeEach(() => {
    for (const m of [totp.setup, totp.enable, totp.disable, totp.regenerate]) { m.mutate.mockReset(); m.reset.mockReset(); }
    totp.setup.data = undefined;
    totp.status.error = null;
  });

  it('off: offers setup', () => {
    totp.status.data = { enabled: false, enabledAt: null, backupCodesRemaining: 0 };
    render(<TotpSection />);
    fireEvent.click(screen.getByTestId('totp-setup'));
    expect(totp.setup.mutate).toHaveBeenCalled();
  });

  it('enrolling: a QR drawn in the browser, the key as text, a code turns it on, then the backup codes ONCE', () => {
    totp.status.data = { enabled: false, enabledAt: null, backupCodesRemaining: 0 };
    totp.setup.data = { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Insula:ada?secret=JBSWY3DPEHPK3PXP' };
    totp.enable.mutate.mockImplementation((_code: string, opts: { onSuccess: (c: string[]) => void }) => opts.onSuccess(['AAAAA-BBBBB', 'CCCCC-DDDDD']));
    render(<TotpSection />);
    expect(screen.getByTestId('totp-qr').getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByTestId('totp-secret')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    fireEvent.change(screen.getByTestId('totp-enroll-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('totp-enable'));
    expect(totp.enable.mutate).toHaveBeenCalledWith('123456', expect.anything());
    expect(screen.getAllByTestId('totp-backup-code').map((e) => e.textContent)).toEqual(['AAAAA-BBBBB', 'CCCCC-DDDDD']);
    expect(screen.getByTestId('totp-codes-done')).toBeDisabled();
    fireEvent.click(screen.getByTestId('totp-codes-stored'));
    expect(screen.getByTestId('totp-codes-done')).toBeEnabled();
  });

  it('on: shows what is left, warns when few, and turning off asks for a code', () => {
    totp.status.data = { enabled: true, enabledAt: '2026-10-01T00:00:00Z', backupCodesRemaining: 2 };
    render(<TotpSection />);
    expect(screen.getByTestId('totp-backup-remaining')).toHaveTextContent('2 backup codes left');
    expect(screen.getByTestId('totp-on')).toHaveTextContent('Few backup codes left');
    fireEvent.click(screen.getByTestId('totp-disable'));
    fireEvent.change(screen.getByTestId('totp-proof-input'), { target: { value: '654321' } });
    fireEvent.click(screen.getByTestId('totp-proof-submit'));
    expect(totp.disable.mutate).toHaveBeenCalledWith({ code: '654321' }, expect.anything());
  });
});

describe('admin reset of a user’s app code', () => {
  beforeEach(() => { resetMutation.mutate.mockReset(); });

  it('only a super_admin sees Reset, and it asks before removing', () => {
    useAuth.setState({ user: { ...user, role: 'admin' } });
    const { unmount } = render(<TotpResetCell userId="u9" enabled />);
    expect(screen.getByTestId('totp-on-u9')).toBeInTheDocument();
    expect(screen.queryByTestId('totp-reset-u9')).not.toBeInTheDocument();
    unmount();
    useAuth.setState({ user: { ...user, role: 'super_admin' } });
    render(<TotpResetCell userId="u9" enabled />);
    fireEvent.click(screen.getByTestId('totp-reset-u9'));
    expect(resetMutation.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('totp-reset-confirm-u9'));
    expect(resetMutation.mutate).toHaveBeenCalledWith('u9', expect.anything());
  });

  it('shows nothing to reset when the app code is off', () => {
    useAuth.setState({ user: { ...user, role: 'super_admin' } });
    render(<TotpResetCell userId="u8" enabled={false} />);
    expect(screen.queryByTestId('totp-reset-u8')).not.toBeInTheDocument();
  });
});
