/**
 * The spam thresholds (Mail Settings → Spam Filter).
 *
 * Worth pinning:
 *   - ONE pair for the whole mail server, and the panel says so;
 *   - "refuse nothing" stays a savable CHOICE (null), and a stored threshold
 *     shows as refusing;
 *   - a refuse score at or below the Junk score blocks the save — it would
 *     refuse mail that should have gone to Junk;
 *   - both values are sent together, so the server checks one against the other;
 *   - an untouched control writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { spamDraftFromSettings, spamThresholdsFromDraft } from './MailSpamFilterSection';

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
  spamJunkScore: 5,
  spamRejectScore: null,
};

function renderTab(overrides: Record<string, unknown> = {}) {
  settingsState.data = { ...SETTINGS, ...overrides };
  render(<MailSettingsTab />);
}
const submit = () => fireEvent.submit(screen.getByTestId('mail-settings-tab'));

beforeEach(() => { mutateAsync.mockClear(); });

describe('spam draft helpers', () => {
  it('maps stored thresholds to a draft and back', () => {
    expect(spamThresholdsFromDraft(spamDraftFromSettings(6.5, 15))).toEqual({ junk: 6.5, reject: 15 });
    expect(spamThresholdsFromDraft(spamDraftFromSettings(5, null))).toEqual({ junk: 5, reject: null });
    // Refusing off still pre-fills a refuse score, so turning it on starts somewhere sensible.
    expect(spamDraftFromSettings(5, null)).toEqual({ junk: '5', reject: '15', refuse: false });
  });

  it('rounds to one decimal', () => {
    expect(spamThresholdsFromDraft({ junk: '6.25', reject: '15', refuse: false })).toEqual({ junk: 6.3, reject: null });
  });

  it.each([
    [{ junk: '0.5', reject: '15', refuse: false }],
    [{ junk: '21', reject: '15', refuse: false }],
    [{ junk: 'abc', reject: '15', refuse: false }],
    [{ junk: '5', reject: '5', refuse: true }],
    [{ junk: '8', reject: '7', refuse: true }],
    [{ junk: '5', reject: '51', refuse: true }],
    [{ junk: '5', reject: '', refuse: true }],
  ])('rejects %j', (draft) => {
    expect(spamThresholdsFromDraft(draft)).toBeUndefined();
  });

  it('ignores the refuse box while refusing is off', () => {
    expect(spamThresholdsFromDraft({ junk: '5', reject: 'abc', refuse: false })).toEqual({ junk: 5, reject: null });
  });
});

describe('MailSettingsTab — spam filter', () => {
  it('says the thresholds are server-wide and that DMARC is always enforced', () => {
    renderTab();
    const section = screen.getByTestId('spam-filter-section');
    expect(section).toHaveTextContent(/one pair, not one per domain/);
    expect(screen.getByTestId('spam-filter-dmarc-note')).toHaveTextContent(/always enforced/);
  });

  it('shows the stored Junk score and saves a change together with the refuse setting', async () => {
    renderTab();
    const junk = screen.getByTestId('spam-junk-score') as HTMLInputElement;
    expect(junk.value).toBe('5');
    expect(screen.getByTestId('spam-reject-score')).toBeDisabled();
    fireEvent.change(junk, { target: { value: '6' } });
    submit();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ spamJunkScore: 6, spamRejectScore: null }));
  });

  it('turning refusing on saves the refuse score', async () => {
    renderTab();
    fireEvent.click(screen.getByTestId('spam-refuse-enabled'));
    fireEvent.change(screen.getByTestId('spam-reject-score'), { target: { value: '12' } });
    submit();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ spamJunkScore: 5, spamRejectScore: 12 }));
  });

  it('a stored refuse threshold shows as refusing, and turning it off saves null', async () => {
    renderTab({ spamRejectScore: 12 });
    const refuse = screen.getByTestId('spam-refuse-enabled') as HTMLInputElement;
    expect(refuse.checked).toBe(true);
    expect((screen.getByTestId('spam-reject-score') as HTMLInputElement).value).toBe('12');
    fireEvent.click(refuse);
    submit();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ spamJunkScore: 5, spamRejectScore: null }));
  });

  it('a refuse score not above the Junk score blocks the whole save and says why', async () => {
    renderTab();
    fireEvent.click(screen.getByTestId('spam-refuse-enabled'));
    fireEvent.change(screen.getByTestId('spam-reject-score'), { target: { value: '5' } });
    expect(screen.getByTestId('spam-filter-invalid')).toHaveTextContent(/above the Junk score/);
    submit();
    expect(await screen.findByText(/Spam filter: enter a Junk score/)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('an untouched control writes nothing', async () => {
    renderTab({ spamJunkScore: 6.5, spamRejectScore: 20 });
    submit();
    // Let the submit handler's awaits settle before asserting nothing was sent.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByText(/Spam filter:/)).not.toBeInTheDocument();
  });
});
