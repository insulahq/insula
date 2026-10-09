/**
 * The automatic-ban lifetime control (Mail Settings → Automatic IP Bans).
 *
 * Worth pinning:
 *   - "never" must stay a reachable, savable CHOICE (null) — distinct from an
 *     untouched setting, which reads as the 24 h default;
 *   - an invalid hours entry must block the save instead of sending something
 *     the server would reject or, worse, clamp;
 *   - an untouched control must not write — a save of another field leaves the
 *     mail server's ban settings alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { draftFromSetting, settingFromDraft } from './MailBanExpirySection';

const mutateAsync = vi.fn(async (_body: unknown) => ({}));
const settingsState: { data: Record<string, unknown> } = { data: {} };
vi.mock('@/hooks/use-webmail-settings', () => ({
  useWebmailSettings: () => ({ data: { data: settingsState.data }, isLoading: false, isError: false, error: null }),
  useUpdateWebmailSettings: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('@/hooks/use-platform-urls', () => ({
  usePlatformUrls: () => ({ data: { stalwartAdminUrl: { source: 'default', value: '', default: '' } }, isLoading: false }),
  useUpdatePlatformUrls: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { default: MailSettingsTab } = await import('./MailSettingsTab');

const SETTINGS = {
  mailServerHostname: 'mail.example.test',
  mailEnforcementMode: 'notify',
  dmarcReportSender: null,
  dmarcReportSenderOptions: [],
  mailBanExpiryHours: 24,
};

function renderTab(overrides: Record<string, unknown> = {}) {
  settingsState.data = { ...SETTINGS, ...overrides };
  render(<MailSettingsTab />);
}
const submit = () => fireEvent.submit(screen.getByTestId('mail-settings-tab'));

beforeEach(() => { mutateAsync.mockClear(); });

describe('draft helpers', () => {
  it('maps the stored value to a draft and back', () => {
    expect(settingFromDraft(draftFromSetting(48))).toBe(48);
    expect(settingFromDraft(draftFromSetting(null))).toBeNull();
    expect(draftFromSetting(null)).toEqual({ hours: '24', never: true }); // never pre-fills the default
    expect(draftFromSetting(undefined)).toEqual({ hours: '24', never: false });
  });

  it.each(['0', '8761', '1.5', '-3', 'abc', ''])('rejects %j hours', (hours) => {
    expect(settingFromDraft({ hours, never: false })).toBeUndefined();
  });
});

describe('MailSettingsTab — automatic IP bans', () => {
  it('shows the stored lifetime and saves a change', async () => {
    renderTab();
    const hours = screen.getByTestId('mail-ban-expiry-hours') as HTMLInputElement;
    expect(hours.value).toBe('24');
    fireEvent.change(hours, { target: { value: '72' } });
    submit();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ mailBanExpiryHours: 72 }));
  });

  it('"never" saves null and disables the hours field', async () => {
    renderTab();
    fireEvent.click(screen.getByTestId('mail-ban-expiry-never'));
    expect(screen.getByTestId('mail-ban-expiry-hours')).toBeDisabled();
    submit();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ mailBanExpiryHours: null }));
  });

  it('a stored "never" shows as checked and can be turned back into hours', async () => {
    renderTab({ mailBanExpiryHours: null });
    const never = screen.getByTestId('mail-ban-expiry-never') as HTMLInputElement;
    expect(never.checked).toBe(true);
    fireEvent.click(never);
    submit();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ mailBanExpiryHours: 24 }));
  });

  it('an invalid entry blocks the whole save and says why', async () => {
    renderTab();
    fireEvent.change(screen.getByTestId('mail-ban-expiry-hours'), { target: { value: '0' } });
    expect(screen.getByTestId('mail-ban-expiry-invalid')).toBeInTheDocument();
    submit();
    expect(await screen.findByText(/Automatic bans: enter a whole number of hours/)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('an untouched control writes nothing', async () => {
    renderTab();
    submit();
    await waitFor(() => expect(screen.getByTestId('mail-settings-tab')).toBeInTheDocument());
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
